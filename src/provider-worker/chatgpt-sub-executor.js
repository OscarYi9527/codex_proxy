import crypto from 'node:crypto'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const ACCOUNT_STRATEGIES = new Set([
  'priority',
  'round-robin',
  'headroom',
  'least-used',
  'latency',
  'reliable',
  'weighted',
  'random',
  'lkgp'
])
const RUNTIME_FIELDS = [
  'access_token',
  'refresh_token',
  'id_token',
  'expires_at',
  'plan_type',
  'usage',
  'usage_updated_at',
  'usage_history',
  'usage_forecast',
  'usage_sync_status',
  'usage_sync_error',
  'cooldown_until',
  'model_cooldowns',
  'last_cooldown_model',
  'last_cooldown_reason',
  'auth_error',
  'last_refresh',
  'reset_credits',
  'reset_credits_error',
  'status'
]
const MAX_ERROR_BODY_BYTES = 128 * 1024
const MAX_USAGE_CAPTURE_BYTES = 256 * 1024

function safeError(code, message, statusCode = 500, retryable = statusCode >= 500) {
  return Object.assign(new Error(message), { code, statusCode, retryable })
}

function providerReloginRequiredError() {
  return safeError(
    'worker_provider_relogin_required',
    'ChatGPT subscription account requires administrator reauthentication',
    409,
    false
  )
}

function isProviderReloginRequired(error) {
  return error?.code === 'TOKEN_REFRESH_RELOGIN_REQUIRED' ||
    error?.code === 'TOKEN_TEMPORARY_ACCESS_EXPIRED'
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value, name, max) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max) {
    throw safeError(
      'worker_runtime_configuration_invalid',
      `Provider Worker ${name} is invalid`,
      400
    )
  }
  return result
}

function optionalText(value, max) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > max) {
    throw safeError(
      'worker_runtime_configuration_invalid',
      'Provider Worker runtime field is invalid',
      400
    )
  }
  return value
}

function number(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

function safeStringList(value, max = 100) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map(item => String(item).trim())
    .filter(item => /^[A-Za-z0-9._:-]{1,160}$/.test(item)))]
    .slice(0, max)
}

function credentialDigest(account) {
  return crypto.createHash('sha256')
    .update(String(account.access_token || ''))
    .update('\0')
    .update(String(account.refresh_token || ''))
    .update('\0')
    .update(String(account.id_token || ''))
    .update('\0')
    .update(String(account.expires_at || ''))
    .digest('hex')
}

function validateResponsesUrl(value, environment) {
  let url
  try {
    url = new URL(text(value, 'ChatGPT Responses URL', 2_000))
  } catch {
    throw safeError(
      'worker_runtime_configuration_invalid',
      'Provider Worker ChatGPT Responses URL is invalid',
      400
    )
  }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
    throw safeError(
      'worker_runtime_configuration_invalid',
      'Provider Worker ChatGPT Responses URL is invalid',
      400
    )
  }
  if (
    (environment === 'preview' || environment === 'production') &&
    url.protocol !== 'https:'
  ) {
    throw safeError(
      'worker_runtime_configuration_invalid',
      'Preview/production ChatGPT Responses URL must use HTTPS',
      400
    )
  }
  return url.toString()
}

function validateAccount(value) {
  const source = object(value)
  const id = text(source.id, 'account ID', 160)
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw safeError(
      'worker_runtime_configuration_invalid',
      'Provider Worker account ID is invalid',
      400
    )
  }
  const accessToken = optionalText(source.access_token, 128 * 1024)
  const refreshToken = optionalText(source.refresh_token, 128 * 1024)
  if (!accessToken && !refreshToken) {
    throw safeError(
      'worker_runtime_configuration_invalid',
      'Provider Worker account credential is missing',
      400
    )
  }
  return {
    id,
    label: optionalText(source.label, 80) || 'ChatGPT account',
    account_id: text(source.account_id, 'upstream account ID', 512),
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: optionalText(source.id_token, 128 * 1024),
    expires_at: source.expires_at ?? null,
    routing_enabled: source.routing_enabled !== false,
    routing_weight: Math.floor(number(source.routing_weight, 1, 1, 100)),
    low_quota_threshold: number(source.low_quota_threshold, 10, 0, 100),
    daily_request_limit: Math.floor(number(
      source.daily_request_limit,
      0,
      0,
      Number.MAX_SAFE_INTEGER
    )),
    daily_token_limit: Math.floor(number(
      source.daily_token_limit,
      0,
      0,
      Number.MAX_SAFE_INTEGER
    )),
    credential_version: Math.max(
      1,
      Math.floor(number(
        source.credential_version,
        1,
        1,
        Number.MAX_SAFE_INTEGER
      ))
    ),
    reserved_models: safeStringList(source.reserved_models, 50),
    status: typeof source.status === 'string' && source.status
      ? source.status.slice(0, 40)
      : 'active'
  }
}

function usageFromValue(value) {
  if (!value || typeof value !== 'object') return null
  const source = value
  const usage = source.usage && typeof source.usage === 'object'
    ? source.usage
    : null
  if (usage) {
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens)
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens)
    if (
      Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0
    ) {
      return { inputTokens, outputTokens }
    }
  }
  for (const nested of Object.values(source)) {
    const found = usageFromValue(nested)
    if (found) return found
  }
  return null
}

function usageFromPayload(payload) {
  const candidates = []
  const value = payload.toString('utf8')
  try {
    candidates.push(JSON.parse(value))
  } catch {
    for (const line of value.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        candidates.push(JSON.parse(data))
      } catch {
        // Ignore partial SSE data. The capture keeps the final events.
      }
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const usage = usageFromValue(candidates[index])
    if (usage) return usage
  }
  return null
}

class SyntheticRequest extends EventEmitter {
  constructor(options) {
    super()
    this.headers = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'thread-id': options.turnId,
      'session-id': options.turnId,
      'x-client-request-id': options.requestId
    }
    this.requestId = options.requestId
    this.fetchImpl = options.fetchImpl
    this.clientAbortSignal = options.signal
    this.aborted = options.signal.aborted
    this.accountLeaseId = null
    this.accountQueueMeta = null
    const abort = () => {
      this.aborted = true
      this.emit('aborted')
    }
    this.cleanupAbort = () => options.signal.removeEventListener('abort', abort)
    options.signal.addEventListener('abort', abort, { once: true })
  }
}

class SyntheticResponse extends PassThrough {
  constructor() {
    super()
    this.on('error', () => {})
    this.statusCode = 200
    this.headers = new Map()
    this.headersSent = false
    this.proxyMeta = {}
    this.headerPromise = new Promise((resolve, reject) => {
      this.resolveHeaders = resolve
      this.rejectHeaders = reject
    })
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value)
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase())
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode
    for (const [name, value] of Object.entries(headers || {})) {
      this.setHeader(name, value)
    }
    if (!this.headersSent) {
      this.headersSent = true
      this.resolveHeaders()
    }
    return this
  }

  failBeforeHeaders(error) {
    if (!this.headersSent) this.rejectHeaders(error)
  }
}

async function collectLimited(stream, limit) {
  const chunks = []
  let size = 0
  for await (const chunkValue of stream) {
    const chunk = Buffer.from(chunkValue)
    size += chunk.length
    if (size > limit) {
      chunk.fill(0)
      for (const item of chunks) item.fill(0)
      return Buffer.alloc(0)
    }
    chunks.push(chunk)
  }
  const result = Buffer.concat(chunks)
  for (const chunk of chunks) chunk.fill(0)
  return result
}

function exhaustedPoolRequiresRelogin(errorBody) {
  if (!errorBody?.length) return false
  try {
    const payload = JSON.parse(errorBody.toString('utf8'))
    const error = object(payload?.error)
    if (![
      'account_pool_exhausted',
      'account_pool_attempts_exhausted'
    ].includes(error.type)) {
      return false
    }
    const details = object(error.details)
    const enabled = Number(details.enabled)
    const authError = Number(details.auth_error)
    const eligible = Number(details.eligible)
    return Number.isSafeInteger(enabled) &&
      enabled > 0 &&
      Number.isSafeInteger(authError) &&
      authError >= enabled &&
      (!Number.isFinite(eligible) || eligible === 0)
  } catch {
    return false
  }
}

function safeUpstreamError(statusCode, errorBody) {
  if (statusCode === 503 && exhaustedPoolRequiresRelogin(errorBody)) {
    return providerReloginRequiredError()
  }
  if (statusCode === 401 || statusCode === 403) {
    return safeError(
      'worker_provider_authentication_failed',
      'ChatGPT subscription account requires login',
      409,
      false
    )
  }
  if (statusCode === 429) {
    return safeError(
      'worker_provider_rate_limited',
      'ChatGPT subscription account pool is cooling down',
      503,
      true
    )
  }
  if (statusCode === 503) {
    return safeError(
      'worker_provider_pool_unavailable',
      'ChatGPT subscription account pool is unavailable',
      503,
      true
    )
  }
  return safeError(
    'worker_provider_upstream_failed',
    'ChatGPT subscription upstream rejected the request',
    statusCode >= 500 ? 502 : 409,
    statusCode >= 500
  )
}

function safeWindow(value) {
  const source = object(value)
  if (!Object.keys(source).length) return null
  const usedPercent = Number.isFinite(Number(source.used_percent))
    ? Number(source.used_percent)
    : null
  const remainingPercent = Number.isFinite(Number(source.remaining_percent))
    ? Number(source.remaining_percent)
    : (usedPercent === null ? null : Math.max(0, 100 - usedPercent))
  return {
    usedPercent,
    remainingPercent,
    resetsAt: Number.isFinite(Number(source.resets_at)) ? Number(source.resets_at) : null,
    windowMinutes: Number.isFinite(Number(source.window_minutes))
      ? Number(source.window_minutes)
      : null
  }
}

function safeAccountPoolSnapshot(runtime) {
  const proxyConfig = runtime.config.proxyConfig
  const diagnostics = runtime.accounts.getAccountRuntimeDiagnostics()
  const runtimeById = new Map(diagnostics.map(item => [item.id, item]))
  const stats = object(runtime.stats.getStats().accounts)
  return {
    strategy: proxyConfig.chatgptAccountStrategy || 'headroom',
    accounts: (proxyConfig.chatgptAccounts || []).map(account => {
      const accountRuntime = object(runtimeById.get(account.id))
      const health = object(stats[account.id])
      const windows = object(health.windows)
      const hour = object(windows['1h'])
      const usage = object(account.usage)
      const accountId = String(account.account_id || '')
      return {
        id: account.id,
        label: String(account.label || 'ChatGPT account').slice(0, 80),
        accountIdPreview: accountId.length <= 12
          ? accountId
          : `${accountId.slice(0, 6)}…${accountId.slice(-6)}`,
        planType: account.plan_type ? String(account.plan_type).slice(0, 80) : null,
        status: String(accountRuntime.status || account.status || 'active').slice(0, 40),
        routingEnabled: account.routing_enabled !== false,
        routingWeight: number(account.routing_weight, 1, 1, 100),
        lowQuotaThreshold: number(account.low_quota_threshold, 10, 0, 100),
        dailyRequestLimit: Math.max(0, Math.floor(Number(account.daily_request_limit) || 0)),
        dailyTokenLimit: Math.max(0, Math.floor(Number(account.daily_token_limit) || 0)),
        reservedModels: safeStringList(account.reserved_models, 50),
        quota: {
          source: 'provider',
          primary: safeWindow(usage.primary),
          secondary: safeWindow(usage.secondary),
          updatedAt: account.usage_updated_at || null,
          syncStatus: account.usage_sync_status || 'pending',
          syncError: account.usage_sync_error
            ? String(account.usage_sync_error).slice(0, 240)
            : null
        },
        runtime: {
          activeRequests: Math.max(0, Number(accountRuntime.active_requests) || 0),
          concurrencyLimit: Math.max(1, Number(accountRuntime.concurrency_limit) || 1),
          cooldownUntil: Number.isFinite(Number(accountRuntime.cooldown_until))
            ? Number(accountRuntime.cooldown_until)
            : null,
          modelCooldowns: Math.max(0, Number(accountRuntime.model_cooldowns) || 0)
        },
        health: {
          requests: Math.max(0, Number(hour.requests ?? health.requests) || 0),
          successRate: Number.isFinite(Number(hour.success_rate))
            ? Number(hour.success_rate)
            : null,
          p95LatencyMs: Math.max(0, Number(hour.p95_latency_ms) || 0),
          rateLimited: Math.max(0, Number(hour.rate_limited ?? health.rate_limited) || 0),
          lastRequestAt: health.last_request_at || null,
          lastErrorType: health.last_error_type || null,
          lastErrorMessage: health.last_error_message
            ? String(health.last_error_message).slice(0, 240)
            : null
        }
      }
    }),
    queueDepth: Math.max(0, Number(runtime.route.getAccountQueueDiagnostics().depth) || 0),
    recentRouteDecisions: runtime.decisions.getRouteDecisions(20).map(decision => ({
      at: decision.at,
      model: decision.model,
      selectedAccountId: decision.selected_account_id,
      selectedAccountLabel: decision.selected_account_label,
      outcome: decision.outcome,
      queueWaitMs: decision.queue_wait_ms,
      accounts: decision.accounts
    }))
  }
}

export class ChatgptSubscriptionExecutor {
  #runtime = null
  #credentialDigests = new Map()
  #modelIds = []
  #enabled = false

  constructor(options) {
    this.dataRoot = options.dataRoot
    this.environment = options.environment || 'development'
    this.fetchImpl = options.fetchImpl || fetch
    this.credentialVault = options.credentialVault || null
  }

  async initialize() {
    if (this.#runtime) return
    fs.mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 })
    process.env.CODEX_PROXY_STORAGE_ROOT = this.dataRoot
    process.env.CODEX_PROXY_RUNTIME_CONFIG_MEMORY_ONLY = '1'
    process.env.NODE_ENV = this.environment
    const [config, route, accounts, stats, decisions, circuits, health, china] =
      await Promise.all([
        import('../config.js'),
        import('../routes/chatgpt-sub.js'),
        import('../chatgpt-accounts.js'),
        import('../stats.js'),
        import('../route-decisions.js'),
        import('../circuit-breaker.js'),
        import('../provider-health.js'),
        import('../china-fetch.js')
      ])
    this.#runtime = {
      config,
      route,
      accounts,
      stats,
      decisions,
      circuits,
      health,
      china
    }
  }

  async configure(value) {
    await this.initialize()
    const source = object(value)
    if (source.schemaVersion !== 1 || source.provider !== 'chatgpt-sub') {
      throw safeError(
        'worker_runtime_configuration_invalid',
        'Provider Worker runtime schema is invalid',
        400
      )
    }
    const responsesUrl = validateResponsesUrl(
      source.responsesUrl,
      this.environment
    )
    const strategy = ACCOUNT_STRATEGIES.has(source.accountStrategy)
      ? source.accountStrategy
      : 'headroom'
    if (!Array.isArray(source.accounts) || source.accounts.length > 500) {
      throw safeError(
        'worker_runtime_configuration_invalid',
        'Provider Worker account pool is invalid',
        400
      )
    }
    const incomingAccounts = source.accounts.map(validateAccount)
    const ids = new Set()
    for (const account of incomingAccounts) {
      if (ids.has(account.id)) {
        throw safeError(
          'worker_runtime_configuration_invalid',
          'Provider Worker account IDs must be unique',
          400
        )
      }
      ids.add(account.id)
    }
    const previousById = new Map(
      (this.#runtime.config.proxyConfig.chatgptAccounts || [])
        .map(account => [account.id, account])
    )
    const nextDigests = new Map()
    const restoredAccounts = this.credentialVault
      ? await this.credentialVault.restore(incomingAccounts)
      : incomingAccounts
    const accounts = restoredAccounts.map((account, index) => {
      const digest = credentialDigest(incomingAccounts[index])
      nextDigests.set(account.id, digest)
      const previous = previousById.get(account.id)
      if (!previous || this.#credentialDigests.get(account.id) !== digest) {
        return account
      }
      const preserved = {}
      for (const field of RUNTIME_FIELDS) {
        if (previous[field] !== undefined) preserved[field] = previous[field]
      }
      return { ...account, ...preserved }
    })
    this.#credentialDigests = nextDigests
    this.#modelIds = safeStringList(source.modelIds, 200)
      .filter(model => /^gpt-/i.test(model))
    this.#enabled = source.enabled === true
    Object.assign(this.#runtime.config.proxyConfig, {
      chatgptResponsesUrl: responsesUrl,
      chatgptAccounts: accounts,
      chatgptAccountStrategy: strategy,
      activeChatgptAccountId: null,
      deepseekApiKey: '',
      openaiApiKey: '',
      relays: [],
      fallbackChain: this.#modelIds.map(model => ({
        provider: 'chatgpt-sub',
        model
      }))
    })
    await this.#persistCredentials()
    return this.configurationStatus()
  }

  configurationStatus() {
    const accounts = this.#runtime?.config.proxyConfig.chatgptAccounts || []
    return {
      schemaVersion: 1,
      provider: 'chatgpt-sub',
      executor: 'chatgpt-sub',
      enabled: this.#enabled,
      accountCount: accounts.length,
      routableAccountCount: accounts.filter(account =>
        account.routing_enabled !== false &&
        (account.access_token || account.refresh_token)
      ).length,
      modelCount: this.#modelIds.length,
      experimental: true
    }
  }

  async listModels() {
    await this.initialize()
    const hasRoutableAccount = this.#enabled &&
      this.#runtime.config.proxyConfig.chatgptAccounts.some(account =>
        account.routing_enabled !== false &&
        (account.access_token || account.refresh_token)
      )
    return {
      object: 'list',
      data: hasRoutableAccount
        ? this.#modelIds.map(id => ({
            id,
            object: 'model',
            owned_by: 'chatgpt-sub-experimental'
          }))
        : []
    }
  }

  async supportsModel(model) {
    const catalog = await this.listModels()
    return catalog.data.some(item => item.id === model)
  }

  async safeAccountPool() {
    await this.initialize()
    return safeAccountPoolSnapshot(this.#runtime)
  }

  async safeDiagnostics() {
    await this.initialize()
    return {
      providers: this.#runtime.health.getProviderHealth(),
      circuits: this.#runtime.circuits.getCircuitStates(),
      recentRouteErrors: this.#runtime.decisions.getRouteDecisions(50)
    }
  }

  async refreshAccountUsage(accountId) {
    await this.initialize()
    const account = this.#runtime.config.proxyConfig.chatgptAccounts
      .find(item => item.id === accountId)
    if (!account) {
      throw safeError(
        'worker_provider_account_not_found',
        'ChatGPT subscription account was not found',
        404,
        false
      )
    }
    await this.#runtime.accounts.refreshAccountUsage(
      account,
      this.#runtime.china.chinaFetch(this.fetchImpl)
    )
    await this.#persistCredentials()
  }

  async execute(options) {
    await this.initialize()
    if (!await this.supportsModel(options.body.model)) {
      throw safeError(
        'worker_model_unavailable',
        'Provider Worker model is not available',
        409,
        true
      )
    }
    const request = new SyntheticRequest({
      turnId: options.turnId,
      requestId: options.requestId,
      signal: options.signal,
      fetchImpl: this.fetchImpl
    })
    const response = new SyntheticResponse()
    response.proxyMeta = {
      requestId: options.requestId,
      startedAt: Date.now()
    }
    const resolved = {
      model: options.body.model,
      bodyModel: options.body.model,
      threadId: options.turnId,
      reasoningEffort: object(options.body.reasoning).effort || null
    }
    const handler = options.kind === 'chat-completions'
      ? this.#runtime.route.handleChatGptSubChatCompletions
      : this.#runtime.route.handleChatGptSub
    const completion = Promise.resolve(
      handler(request, response, options.body, resolved)
    ).catch(error => {
      response.failBeforeHeaders(error)
      if (!response.destroyed) response.destroy(error)
      throw error
    })
    completion.catch(() => {})
    try {
      await response.headerPromise
    } catch (error) {
      await completion.catch(() => {})
      await this.#persistCredentials()
      request.cleanupAbort()
      if (isProviderReloginRequired(error)) {
        throw providerReloginRequiredError()
      }
      throw error
    }
    await this.#persistCredentials()
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errorBody = await collectLimited(response, MAX_ERROR_BODY_BYTES)
      try {
        await completion.catch(() => {})
        request.cleanupAbort()
        throw safeUpstreamError(response.statusCode, errorBody)
      } finally {
        errorBody.fill(0)
      }
    }

    const usage = {
      inputTokens: Math.max(1, Math.ceil(Buffer.byteLength(
        JSON.stringify(options.body),
        'utf8'
      ) / 4)),
      outputTokens: 0,
      estimated: true
    }
    const providerId = 'chatgpt-sub'
    return {
      providerId,
      usage,
      async *stream() {
        const captured = []
        let capturedBytes = 0
        try {
          for await (const chunkValue of response) {
            const chunk = Buffer.from(chunkValue)
            capturedBytes += chunk.length
            captured.push(Buffer.from(chunk))
            while (
              capturedBytes > MAX_USAGE_CAPTURE_BYTES &&
              captured.length > 1
            ) {
              const removed = captured.shift()
              capturedBytes -= removed.length
              removed.fill(0)
            }
            yield chunk
          }
          await completion
          const payload = Buffer.concat(captured)
          const parsed = usageFromPayload(payload)
          payload.fill(0)
          if (parsed) {
            Object.assign(usage, parsed)
            delete usage.estimated
          } else {
            usage.outputTokens = Math.max(1, Math.ceil(capturedBytes / 4))
          }
        } finally {
          request.cleanupAbort()
          for (const chunk of captured) chunk.fill(0)
        }
      }
    }
  }

  async #persistCredentials() {
    if (!this.credentialVault || !this.#runtime) return
    await this.credentialVault.snapshot(
      this.#runtime.config.proxyConfig.chatgptAccounts || []
    )
  }
}
