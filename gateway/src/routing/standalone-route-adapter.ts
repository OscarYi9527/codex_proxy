import { Readable, Writable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { redactValue } from '../common/redaction.js'

export interface SafeModel {
  readonly id: string
  readonly object: 'model'
  readonly owned_by: string
}

export interface SafeModelList {
  readonly object: 'list'
  readonly data: SafeModel[]
}

export interface ProviderForwardResult {
  readonly providerId?: string
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
}

export interface ProviderRouteAdapter {
	listModels(): Promise<SafeModelList>
  forwardResponses(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<void | ProviderForwardResult>
  forwardChatCompletions?(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
	): Promise<void | ProviderForwardResult>
	configureProviders?(configuration: GatewayProviderRuntimeConfiguration): Promise<void>
	safeDiagnostics?(): Promise<Record<string, unknown>>
	safeAccountPool?(): Promise<SafeAccountPoolSnapshot>
	refreshChatgptAccountUsage?(accountId: string): Promise<void>
}

export type AccountRoutingStrategy =
	| 'priority'
	| 'round-robin'
	| 'headroom'
	| 'least-used'
	| 'latency'
	| 'reliable'
	| 'weighted'
	| 'random'
	| 'lkgp'

export interface SafeQuotaWindow {
	readonly usedPercent: number | null
	readonly remainingPercent: number | null
	readonly resetsAt: number | null
	readonly windowMinutes: number | null
}

export interface SafeAccountPoolAccount {
	readonly id: string
	readonly label: string
	readonly accountIdPreview: string | null
	readonly planType: string | null
	readonly status: string
	readonly routingEnabled: boolean
	readonly routingWeight: number
	readonly lowQuotaThreshold: number
	readonly dailyRequestLimit: number
	readonly dailyTokenLimit: number
	readonly reservedModels: readonly string[]
	readonly quota: {
		readonly source: 'provider'
		readonly primary: SafeQuotaWindow | null
		readonly secondary: SafeQuotaWindow | null
		readonly updatedAt: string | null
		readonly syncStatus: string
		readonly syncError: string | null
	}
	readonly runtime: {
		readonly activeRequests: number
		readonly concurrencyLimit: number
		readonly cooldownUntil: number | null
		readonly modelCooldowns: number
	}
	readonly health: {
		readonly requests: number
		readonly successRate: number | null
		readonly p95LatencyMs: number
		readonly rateLimited: number
		readonly lastRequestAt: string | null
		readonly lastErrorType: string | null
		readonly lastErrorMessage: string | null
	}
}

export interface SafeAccountPoolSnapshot {
	readonly strategy: AccountRoutingStrategy
	readonly accounts: readonly SafeAccountPoolAccount[]
	readonly queueDepth: number
	readonly recentRouteDecisions: ReadonlyArray<{
		readonly at: string
		readonly model: string
		readonly selectedAccountId: string | null
		readonly selectedAccountLabel: string | null
		readonly outcome: string
		readonly queueWaitMs: number
		readonly accounts: ReadonlyArray<{
			readonly id: string
			readonly label: string
			readonly result: string
			readonly reason: string
			readonly remainingPercent: number | null
		}>
	}>
}

export interface GatewayProviderRuntimeConfiguration {
  readonly deepseekApiKey: string
  readonly deepseekUrl: string
  readonly openaiApiKey: string
  readonly openaiApiBaseUrl: string
	readonly chatgptResponsesUrl: string
	readonly chatgptAccounts: readonly Record<string, unknown>[]
	readonly chatgptAccountStrategy: AccountRoutingStrategy
  readonly relays: ReadonlyArray<{
    id: string
    name: string
    base_url: string
    api_key: string
    models: readonly string[]
  }>
  readonly fallbackChain: ReadonlyArray<{
    provider: string
    model: string
  }>
  readonly modelIds: readonly string[]
}

class SyntheticRequest extends Readable {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly socket = { remoteAddress: '127.0.0.1' }
  #payload: Buffer | null

  constructor(options: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: Record<string, unknown>
  }) {
    super()
    this.method = options.method
    this.url = options.url
    this.headers = {
      host: '127.0.0.1',
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
    this.#payload = options.body
      ? Buffer.from(JSON.stringify(options.body), 'utf8')
      : null
  }

  override _read(): void {
    if (this.#payload) {
      this.push(Buffer.from(this.#payload))
      this.#payload.fill(0)
      this.#payload = null
    }
    this.push(null)
  }
}

class ResponseBase extends Writable {
  statusCode = 200
  headersSent = false
  readonly headers = new Map<string, string | number | readonly string[]>()

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value)
    return this
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers.get(name.toLowerCase())
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase())
  }

  writeHead(
    statusCode: number,
    headers?: Record<string, string | number | readonly string[]>
  ): this {
    this.statusCode = statusCode
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    }
    this.headersSent = true
    return this
  }
}

class MemoryResponse extends ResponseBase {
  readonly chunks: Buffer[] = []

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
    callback()
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

class ForwardResponse extends ResponseBase {
  #usageCapture = ''

  constructor(private readonly target: FastifyReply['raw']) {
    super()
  }

  override writeHead(
    statusCode: number,
    headers?: Record<string, string | number | readonly string[]>
  ): this {
    super.writeHead(statusCode, headers)
    if (!this.target.headersSent && !this.target.destroyed) {
      const outgoing: Record<string, string | number | string[]> = {}
      for (const [name, value] of this.headers) {
        outgoing[name] = Array.isArray(value) ? [...value] : value as string | number
      }
      this.target.writeHead(statusCode, outgoing)
    }
    return this
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (this.#usageCapture.length < 128 * 1024) {
      this.#usageCapture += Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : chunk
      if (this.#usageCapture.length > 128 * 1024) {
        this.#usageCapture = this.#usageCapture.slice(-128 * 1024)
      }
    }
    if (this.target.destroyed || this.target.writableEnded) {
      callback()
      return
    }
    this.target.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.target.destroyed && !this.target.writableEnded) this.target.end()
    callback()
  }

  result(): ProviderForwardResult {
    const candidates: unknown[] = []
    try {
      candidates.push(JSON.parse(this.#usageCapture))
    } catch {
      for (const line of this.#usageCapture.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          candidates.push(JSON.parse(data))
        } catch {
          // Ignore partial or non-JSON SSE data while preserving the stream.
        }
      }
    }
    for (const candidate of candidates.reverse()) {
      const usage = findUsage(candidate)
      if (usage) {
        this.#usageCapture = ''
        return { usage }
      }
    }
    this.#usageCapture = ''
    return {}
  }
}

type StandaloneHandler = (request: SyntheticRequest, response: ResponseBase) => Promise<void>

function findUsage(value: unknown): ProviderForwardResult['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const object = value as Record<string, unknown>
  const usage = object['usage']
  if (usage && typeof usage === 'object') {
    const record = usage as Record<string, unknown>
    const inputTokens = Number(record['input_tokens'] ?? record['prompt_tokens'])
    const outputTokens = Number(record['output_tokens'] ?? record['completion_tokens'])
    if (
      Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0
    ) {
      return { inputTokens, outputTokens }
    }
  }
  for (const nested of Object.values(object)) {
    const found = findUsage(nested)
    if (found) return found
  }
	return undefined
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
}

function finite(value: unknown, fallback = 0): number {
	const result = Number(value)
	return Number.isFinite(result) ? result : fallback
}

function nullableFinite(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null
	const result = Number(value)
	return Number.isFinite(result) ? result : null
}

function safeText(value: unknown, max = 300): string | null {
	if (typeof value !== 'string' || !value.trim()) return null
	return value.trim().slice(0, max)
}

function accountIdPreview(value: unknown): string | null {
	const id = safeText(value, 160)
	if (!id) return null
	if (id.length <= 12) return id
	return `${id.slice(0, 6)}…${id.slice(-6)}`
}

function safeQuotaWindow(value: unknown): SafeQuotaWindow | null {
	const window = record(value)
	if (!Object.keys(window).length) return null
	const usedPercent = nullableFinite(window['used_percent'])
	const remaining = nullableFinite(window['remaining_percent'])
	return {
		usedPercent,
		remainingPercent: remaining ?? (usedPercent === null ? null : Math.max(0, 100 - usedPercent)),
		resetsAt: nullableFinite(window['resets_at']),
		windowMinutes: nullableFinite(window['window_minutes'])
	}
}

export function safeAccountPoolSnapshot(
	proxyConfig: Record<string, unknown>,
	runtimeValue: unknown,
	statsValue: unknown,
	queueValue: unknown,
	decisionsValue: unknown
): SafeAccountPoolSnapshot {
	const runtime = Array.isArray(runtimeValue) ? runtimeValue.map(record) : []
	const stats = record(record(statsValue)['accounts'])
	const configured = Array.isArray(proxyConfig['chatgptAccounts'])
		? proxyConfig['chatgptAccounts'].map(record)
		: []
	const accounts = configured.map<SafeAccountPoolAccount>(account => {
		const id = String(account['id'] || '')
		const runtimeAccount = runtime.find(item => item['id'] === id) || {}
		const health = record(stats[id])
		const usage = record(account['usage'])
		return {
			id,
			label: safeText(account['label'], 80) || 'ChatGPT 账号',
			accountIdPreview: accountIdPreview(account['account_id']),
			planType: safeText(account['plan_type'], 80),
			status: safeText(runtimeAccount['status'], 40) || safeText(account['status'], 40) || 'active',
			routingEnabled: account['routing_enabled'] !== false,
			routingWeight: Math.max(1, Math.min(100, finite(account['routing_weight'], 1))),
			lowQuotaThreshold: Math.max(0, Math.min(100, finite(
				account['low_quota_threshold'],
				finite(proxyConfig['chatgptLowQuotaThreshold'], 10)
			))),
			dailyRequestLimit: Math.max(0, Math.floor(finite(account['daily_request_limit']))),
			dailyTokenLimit: Math.max(0, Math.floor(finite(account['daily_token_limit']))),
			reservedModels: Array.isArray(account['reserved_models'])
				? account['reserved_models'].map(value => String(value)).slice(0, 50)
				: [],
			quota: {
				source: 'provider',
				primary: safeQuotaWindow(usage['primary']),
				secondary: safeQuotaWindow(usage['secondary']),
				updatedAt: safeText(account['usage_updated_at'], 80),
				syncStatus: safeText(account['usage_sync_status'], 40) || 'pending',
				syncError: safeText(account['usage_sync_error'], 240)
			},
			runtime: {
				activeRequests: Math.max(0, finite(runtimeAccount['active_requests'])),
				concurrencyLimit: Math.max(1, finite(runtimeAccount['concurrency_limit'], 3)),
				cooldownUntil: nullableFinite(runtimeAccount['cooldown_until']),
				modelCooldowns: Math.max(0, finite(runtimeAccount['model_cooldowns']))
			},
			health: {
				requests: Math.max(0, finite(health['requests'])),
				successRate: nullableFinite(health['success_rate']),
				p95LatencyMs: Math.max(0, finite(health['p95_latency_ms'])),
				rateLimited: Math.max(0, finite(health['rate_limited'])),
				lastRequestAt: safeText(health['last_request_at'], 80),
				lastErrorType: safeText(health['last_error_type'], 80),
				lastErrorMessage: safeText(health['last_error_message'], 240)
			}
		}
	})
	const decisions = Array.isArray(decisionsValue) ? decisionsValue.map(record) : []
	return {
		strategy: String(proxyConfig['chatgptAccountStrategy'] || 'headroom') as AccountRoutingStrategy,
		accounts,
		queueDepth: Math.max(0, finite(record(queueValue)['depth'])),
		recentRouteDecisions: decisions.slice(0, 20).map(decision => ({
			at: safeText(decision['at'], 80) || '',
			model: safeText(decision['model'], 160) || '',
			selectedAccountId: safeText(decision['selected_account_id'], 160),
			selectedAccountLabel: safeText(decision['selected_account_label'], 80),
			outcome: safeText(decision['outcome'], 80) || 'selected',
			queueWaitMs: Math.max(0, finite(decision['queue_wait_ms'])),
			accounts: (Array.isArray(decision['accounts']) ? decision['accounts'] : [])
				.map(record)
				.slice(0, 50)
				.map(item => ({
					id: safeText(item['id'], 160) || '',
					label: safeText(item['label'], 80) || '',
					result: safeText(item['result'], 80) || '',
					reason: safeText(item['reason'], 160) || '',
					remainingPercent: nullableFinite(item['remaining_percent'])
				}))
		}))
	}
}

const CHATGPT_RUNTIME_FIELDS = [
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
	'added_at',
	'reset_credits',
	'reset_credits_error',
	'status'
] as const

function preserveChatgptRuntime(
	incoming: Record<string, unknown>,
	previous: Record<string, unknown> | undefined
): Record<string, unknown> {
	if (!previous) return { ...incoming }
	const preserved: Record<string, unknown> = {}
	for (const key of CHATGPT_RUNTIME_FIELDS) {
		if (previous[key] !== undefined) preserved[key] = previous[key]
	}
	return { ...incoming, ...preserved }
}

export class StandaloneRouteAdapter implements ProviderRouteAdapter {
  #handler: StandaloneHandler | null = null
  #proxyConfig: Record<string, unknown> | null = null
	#modelIds: readonly string[] = []
	#diagnostics: (() => Promise<Record<string, unknown>>) | null = null
	#accountPool: (() => SafeAccountPoolSnapshot) | null = null

  constructor(private readonly options: { storageRoot: string }) {}

  async listModels(): Promise<SafeModelList> {
    const modelResponse = await this.requestMemory('GET', '/v1/models')
    const readinessResponse = await this.requestMemory('GET', '/ready')
    const modelBody = modelResponse.body()
    const readinessBody = readinessResponse.body()
    try {
      if (modelResponse.statusCode !== 200) {
        throw new Error(`Model catalog returned ${modelResponse.statusCode}`)
      }
      const value = JSON.parse(modelBody.toString('utf8')) as SafeModelList
      if (value.object !== 'list' || !Array.isArray(value.data)) {
        throw new Error('Model catalog response is invalid')
      }
      const readiness = JSON.parse(readinessBody.toString('utf8')) as {
        providers?: {
          deepseek?: boolean
          'openai-api'?: boolean
          'chatgpt-sub'?: boolean
          relays?: string[]
        }
      }
      const providers = readiness.providers || {}
      const relays = Array.isArray(providers.relays) ? providers.relays : []
      const anyProvider = Boolean(
        providers.deepseek ||
        providers['openai-api'] ||
        providers['chatgpt-sub'] ||
        relays.length
      )
      const configuredModels = this.#modelIds.map<SafeModel>(id => ({
        id,
        object: 'model',
        owned_by: 'gateway-config'
      }))
      return {
        object: 'list',
        data: [...value.data, ...configuredModels]
          .filter((model, index, models) =>
            models.findIndex(candidate => candidate.id === model.id) === index
          )
          .filter(model => {
          if (['auto', 'auto-fast', 'auto-cheap', 'auto-reliable'].includes(model.id)) {
            return anyProvider
          }
          if (model.id.startsWith('relay-')) {
            return relays.some(relayId => model.id.startsWith(`relay-${relayId}-`))
          }
          if (model.id.startsWith('openai-api-')) return providers['openai-api'] === true
          if (/^gpt-/i.test(model.id)) return providers['chatgpt-sub'] === true
          return providers.deepseek === true
          })
      }
    } finally {
      modelBody.fill(0)
      readinessBody.fill(0)
      for (const chunk of modelResponse.chunks) chunk.fill(0)
      for (const chunk of readinessResponse.chunks) chunk.fill(0)
    }
  }

  async forwardResponses(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<ProviderForwardResult> {
    return this.forward('/v1/responses', request, reply, body)
  }

  async forwardChatCompletions(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<ProviderForwardResult> {
    return this.forward('/v1/chat/completions', request, reply, body)
  }

  private async forward(
    url: string,
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<ProviderForwardResult> {
    reply.hijack()
    const response = new ForwardResponse(reply.raw)
    await this.handler()(new SyntheticRequest({
      method: 'POST',
      url,
      headers: {
        accept: String(request.headers.accept || 'text/event-stream')
      },
      body
    }), response)
    if (!response.writableEnded) {
      await new Promise<void>((resolve, reject) => {
        response.once('finish', resolve)
        response.once('error', reject)
      })
    }
    return response.result()
  }

  private async requestMemory(method: string, url: string): Promise<MemoryResponse> {
    const response = new MemoryResponse()
    await this.handler()(new SyntheticRequest({ method, url }), response)
    if (!response.writableEnded) {
      await new Promise<void>((resolve, reject) => {
        response.once('finish', resolve)
        response.once('error', reject)
      })
    }
    return response
  }

	async configureProviders(
    configuration: GatewayProviderRuntimeConfiguration
  ): Promise<void> {
    if (!this.#proxyConfig) {
      throw new Error('Standalone provider adapter is not initialized')
    }
		const currentAccounts = Array.isArray(this.#proxyConfig['chatgptAccounts'])
			? this.#proxyConfig['chatgptAccounts'].map(record)
			: []
		const currentById = new Map(currentAccounts.map(account => [String(account['id'] || ''), account]))
		Object.assign(this.#proxyConfig, {
      deepseekApiKey: configuration.deepseekApiKey,
      upstreamUrl: configuration.deepseekUrl,
      openaiApiKey: configuration.openaiApiKey,
      openaiApiBaseUrl: configuration.openaiApiBaseUrl,
      openaiApiResponsesUrl: `${configuration.openaiApiBaseUrl.replace(/\/+$/, '')}/responses`,
      openaiApiChatCompletionsUrl:
        `${configuration.openaiApiBaseUrl.replace(/\/+$/, '')}/chat/completions`,
      openaiApiUpstream: 'official',
      chatgptResponsesUrl: configuration.chatgptResponsesUrl,
			chatgptAccounts: configuration.chatgptAccounts.map(account =>
				preserveChatgptRuntime(
					{ ...account },
					currentById.get(String(account['id'] || ''))
				)
			),
			chatgptAccountStrategy: configuration.chatgptAccountStrategy,
      activeChatgptAccountId:
        String(configuration.chatgptAccounts[0]?.['id'] || '') || null,
      relays: configuration.relays.map(relay => ({
        ...relay,
        models: [...relay.models]
      })),
      fallbackChain: configuration.fallbackChain.map(route => ({ ...route }))
    })
    this.#modelIds = [...configuration.modelIds]
  }

	async safeDiagnostics(): Promise<Record<string, unknown>> {
    if (!this.#diagnostics) return {}
    return redactValue(await this.#diagnostics()) as Record<string, unknown>
	}

	async safeAccountPool(): Promise<SafeAccountPoolSnapshot> {
		if (!this.#accountPool) {
			return {
				strategy: 'headroom',
				accounts: [],
				queueDepth: 0,
				recentRouteDecisions: []
			}
		}
		return this.#accountPool()
	}

	async refreshChatgptAccountUsage(accountId: string): Promise<void> {
		const response = await this.requestMemory(
			'POST',
			`/admin/api/chatgpt-accounts/${encodeURIComponent(accountId)}/refresh-usage`
		)
		const body = response.body()
		try {
			if (response.statusCode !== 200) {
				let message = `Account usage refresh returned ${response.statusCode}`
				try {
					const parsed = record(JSON.parse(body.toString('utf8')))
					message = safeText(record(parsed['error'])['message'], 240) || message
				} catch {
					// Preserve the safe status-only fallback for malformed responses.
				}
				throw new Error(message)
			}
		} finally {
			body.fill(0)
			for (const chunk of response.chunks) chunk.fill(0)
		}
	}

  private handler(): StandaloneHandler {
    if (this.#handler) return this.#handler
    throw new Error('Standalone provider adapter is not initialized; call initialize()')
  }

  async initialize(): Promise<void> {
    if (this.#handler) return
    process.env['CODEX_PROXY_STORAGE_ROOT'] = path.resolve(this.options.storageRoot)
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..'
    )
    const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'src', 'server.js')).href
    const module = await import(moduleUrl) as {
      createServer(options?: { fetchImpl?: typeof fetch }): {
        listeners(name: string): unknown[]
        close(): void
      }
    }
    const configModule = await import(
      pathToFileURL(path.join(repositoryRoot, 'src', 'config.js')).href
    ) as { proxyConfig: Record<string, unknown> }
    this.#proxyConfig = configModule.proxyConfig
    const circuits = await import(
      pathToFileURL(path.join(repositoryRoot, 'src', 'circuit-breaker.js')).href
    ) as Record<string, unknown>
    const health = await import(
      pathToFileURL(path.join(repositoryRoot, 'src', 'provider-health.js')).href
    ) as Record<string, unknown>
		const decisions = await import(
      pathToFileURL(path.join(repositoryRoot, 'src', 'route-decisions.js')).href
		) as Record<string, unknown>
		const accounts = await import(
			pathToFileURL(path.join(repositoryRoot, 'src', 'chatgpt-accounts.js')).href
		) as Record<string, unknown>
		const stats = await import(
			pathToFileURL(path.join(repositoryRoot, 'src', 'stats.js')).href
		) as Record<string, unknown>
		const chatgptRoute = await import(
			pathToFileURL(path.join(repositoryRoot, 'src', 'routes', 'chatgpt-sub.js')).href
		) as Record<string, unknown>
		this.#diagnostics = async () => ({
      providers: typeof health['getProviderHealth'] === 'function'
        ? (health['getProviderHealth'] as () => unknown)()
        : {},
      circuits: typeof circuits['getCircuitStates'] === 'function'
        ? (circuits['getCircuitStates'] as () => unknown)()
        : {},
      recentRouteErrors: typeof decisions['getRouteDecisions'] === 'function'
        ? (decisions['getRouteDecisions'] as (limit: number) => unknown)(50)
        : []
		})
		this.#accountPool = () => safeAccountPoolSnapshot(
			this.#proxyConfig || {},
			typeof accounts['getAccountRuntimeDiagnostics'] === 'function'
				? (accounts['getAccountRuntimeDiagnostics'] as () => unknown)()
				: [],
			typeof stats['getStats'] === 'function'
				? (stats['getStats'] as () => unknown)()
				: {},
			typeof chatgptRoute['getAccountQueueDiagnostics'] === 'function'
				? (chatgptRoute['getAccountQueueDiagnostics'] as () => unknown)()
				: {},
			typeof decisions['getRouteDecisions'] === 'function'
				? (decisions['getRouteDecisions'] as (limit: number) => unknown)(20)
				: []
		)
    const server = module.createServer()
    const listener = server.listeners('request')[0]
    if (typeof listener !== 'function') throw new Error('Standalone request handler is unavailable')
    this.#handler = async (request, response) => {
      await (listener as (request: unknown, response: unknown) => Promise<void>)(request, response)
    }
  }
}
