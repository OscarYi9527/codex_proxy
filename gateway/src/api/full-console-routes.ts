import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AccessIdentity } from '../auth/types.js'
import { SafeError } from '../common/errors.js'
import type { RateService } from '../credits/rate-service.js'
import type { ProviderService } from '../providers/provider-service.js'

type ProviderList = Awaited<ReturnType<ProviderService['list']>>
type ConsoleUsage = Awaited<ReturnType<ProviderService['consoleUsage']>>
type ProviderSummary = ProviderList['providers'][number]
type ProviderCredential = ProviderSummary['credentials'][number]

const DEFAULT_URLS = {
  deepseek: 'https://api.deepseek.com/anthropic/v1/messages',
  openai: 'https://api.openai.com/v1',
  chatgpt: 'https://chatgpt.com/backend-api/codex/responses'
} as const

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError({
      code: 'invalid_request',
      message: '请求正文无效。',
      statusCode: 400
    })
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function identity(request: FastifyRequest): AccessIdentity {
  if (!request.accountIdentity) {
    throw new SafeError({
      code: 'login_required',
      message: '需要登录 AI Editor 产品账号。',
      statusCode: 401
    })
  }
  if (request.accountIdentity.role !== 'level1') {
    throw new SafeError({
      code: 'forbidden',
      message: '浏览器完整管理平台仅对一级管理员开放。',
      statusCode: 403
    })
  }
  return request.accountIdentity
}

function safeError(message: string, statusCode = 409): SafeError {
  return new SafeError({
    code: 'full_console_operation_unavailable',
    message,
    statusCode
  })
}

function isMaskedSecret(value: string): boolean {
  return !value || value.includes('*') || value.includes('...')
}

function quotaWindow(value: ProviderCredential['quota']['primary']) {
  if (!value) return null
  const resetAfterSeconds = value.resetsAt === null
    ? null
    : Math.max(0, Math.round(value.resetsAt - Date.now() / 1000))
  return {
    used_percent: value.usedPercent,
    remaining_percent: value.remainingPercent,
    resets_at: value.resetsAt,
    reset_after_seconds: resetAfterSeconds,
    limit_window_seconds: value.windowMinutes === null
      ? null
      : value.windowMinutes * 60
  }
}

function accountFromCredential(credential: ProviderCredential) {
  return {
    id: credential.id,
    label: credential.label || credential.accountIdPreview || 'ChatGPT 订阅账号',
    account_id: credential.accountIdPreview || credential.id,
    plan_type: credential.planType || '订阅套餐',
    status: credential.status === 'unknown' ? 'active' : credential.status,
    credential_mode: 'refreshable',
    credential_compatibility: 'codex_subscription',
    pool_tier: 'stable',
    routing_enabled: credential.routing?.enabled !== false,
    routing_weight: credential.routing?.weight || 1,
    low_quota_threshold: credential.routing?.lowQuotaThreshold ?? 10,
    daily_request_limit: credential.routing?.dailyRequestLimit || 0,
    daily_token_limit: credential.routing?.dailyTokenLimit || 0,
    reserved_models: credential.routing?.reservedModels || [],
    usage: {
      primary: quotaWindow(credential.quota.primary),
      secondary: quotaWindow(credential.quota.secondary)
    },
    usage_sync_status: credential.quota.syncStatus,
    usage_sync_error: credential.quota.syncError,
    usage_updated_at: credential.quota.updatedAt,
    active_requests: credential.runtime.activeRequests,
    concurrency_limit: credential.runtime.concurrencyLimit,
    cooldown_until: credential.runtime.cooldownUntil,
    model_cooldowns: credential.runtime.modelCooldowns > 0
      ? { active: Date.now() + 60_000 }
      : {},
    health: credential.health
  }
}

function providerKey(provider: ProviderSummary): string {
  if (provider.kind === 'chatgpt') return 'chatgpt-sub'
  if (provider.kind === 'openai') return 'openai-api'
  if (provider.kind === 'relay') return `relay:${provider.id}`
  return 'deepseek'
}

function publicConfig(list: ProviderList, models: Awaited<ReturnType<ProviderService['models']>>) {
  const providerOf = (kind: ProviderSummary['kind']) =>
    list.providers.find(provider => provider.kind === kind)
  const openai = providerOf('openai')
  const deepseek = providerOf('deepseek')
  const chatgptProviders = list.providers.filter(provider => provider.kind === 'chatgpt')
  const relays = list.providers.filter(provider => provider.kind === 'relay')
  const firstEnabledModel = models.models
    .filter(model => model.enabled)
    .sort((left, right) => left.priority - right.priority)[0]
  const credentialPreview = (provider: ProviderSummary | undefined) =>
    provider?.credentials[0]?.maskedPreview || ''
  return {
    deploymentMode: 'gateway',
    defaultModel: firstEnabledModel?.publicModelId || '',
    deepseekApiKey: credentialPreview(deepseek),
    upstreamUrl: text(deepseek?.config['baseUrl']) || DEFAULT_URLS.deepseek,
    openaiApiKey: credentialPreview(openai),
    openaiApiBaseUrl: text(openai?.config['baseUrl']) || DEFAULT_URLS.openai,
    openaiApiResponsesUrl: '',
    openaiApiChatCompletionsUrl: '',
    openaiOrgId: '',
    openaiProjectId: '',
    chatgptResponsesUrl:
      text(chatgptProviders[0]?.config['baseUrl']) || DEFAULT_URLS.chatgpt,
    chatgptAccountStrategy: list.accountPool.strategy,
    chatgptLowQuotaThreshold:
      chatgptProviders.flatMap(provider => provider.credentials)[0]
        ?.routing?.lowQuotaThreshold ?? 10,
    chatgptAccounts: chatgptProviders.flatMap(provider =>
      provider.credentials.map(accountFromCredential)
    ),
    activeChatgptAccountId: null,
    relays: relays.map(provider => ({
      id: provider.id,
      name: provider.displayName,
      base_url: text(provider.config['baseUrl']),
      api_key: credentialPreview(provider),
      models: Array.isArray(provider.config['models'])
        ? provider.config['models']
        : []
    })),
    crossProviderFallbackEnabled: false,
    fallbackChain: [],
    fallbackStatuses: [429, 502, 503, 504],
    providerBudgets: Object.fromEntries(list.providers
      .filter(provider => provider.usage.internalBudgetCredits !== null)
      .map(provider => [
        providerKey(provider),
        { credits: provider.usage.internalBudgetCredits }
      ]))
  }
}

function shanghaiDayKey(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value))
  const part = (type: string) => parts.find(item => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function providerStats(list: ProviderList, usage: ConsoleUsage) {
  const providers: Record<string, unknown> = {}
  const accounts: Record<string, unknown> = {}
  const daily: Record<string, {
    requests: number
    account_attempts: number
    input_tokens: number
    output_tokens: number
    providers: Record<string, {
      requests: number
      input_tokens: number
      output_tokens: number
    }>
    accounts: Record<string, {
      requests: number
      successes: number
      failures: number
      input_tokens: number
      output_tokens: number
    }>
  }> = {}
  for (const provider of list.providers) {
    const key = providerKey(provider)
    const models = usage.models
      .filter(item => item.providerId === provider.id)
      .map(item => [item.modelId, {
        requests: item.requests,
        input_tokens: item.inputTokens,
        output_tokens: item.outputTokens
      }])
    providers[key] = {
      requests: provider.usage.requests,
      input_tokens: provider.usage.inputTokens,
      output_tokens: provider.usage.outputTokens,
      models: Object.fromEntries(models)
    }
    for (const credential of provider.credentials) {
      accounts[credential.id] = {
        requests: credential.health.requests,
        successes: credential.health.successRate === null
          ? 0
          : Math.round(credential.health.requests * credential.health.successRate / 100),
        failures: credential.health.successRate === null
          ? 0
          : Math.max(
              0,
              credential.health.requests -
                Math.round(credential.health.requests * credential.health.successRate / 100)
            ),
        success_rate: credential.health.successRate,
        p95_latency_ms: credential.health.p95LatencyMs,
        rate_limited: credential.health.rateLimited,
        windows: {
          '1h': {
            requests: credential.health.requests,
            success_rate: credential.health.successRate,
            p95_latency_ms: credential.health.p95LatencyMs,
            rate_limited: credential.health.rateLimited
          },
          '24h': {
            requests: credential.health.requests,
            success_rate: credential.health.successRate,
            p95_latency_ms: credential.health.p95LatencyMs,
            rate_limited: credential.health.rateLimited
          },
          '7d': {
            requests: credential.health.requests,
            success_rate: credential.health.successRate,
            p95_latency_ms: credential.health.p95LatencyMs,
            rate_limited: credential.health.rateLimited
          }
        }
      }
    }
  }
  const providerById = new Map(list.providers.map(provider => [
    provider.id,
    providerKey(provider)
  ]))
  for (const record of usage.records) {
    const provider = providerById.get(record.providerId)
    if (!provider) continue
    const key = shanghaiDayKey(record.completedAt)
    const day = daily[key] ||= {
      requests: 0,
      account_attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      providers: {},
      accounts: {}
    }
    day.requests += 1
    day.account_attempts += 1
    day.input_tokens += record.inputTokens
    day.output_tokens += record.outputTokens
    const providerDay = day.providers[provider] ||= {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0
    }
    providerDay.requests += 1
    providerDay.input_tokens += record.inputTokens
    providerDay.output_tokens += record.outputTokens
    const accountDay = day.accounts[record.accountId] ||= {
      requests: 0,
      successes: 0,
      failures: 0,
      input_tokens: 0,
      output_tokens: 0
    }
    accountDay.requests += 1
    accountDay.successes += 1
    accountDay.input_tokens += record.inputTokens
    accountDay.output_tokens += record.outputTokens
  }
  return {
    providers,
    accounts,
    daily,
    updated: new Date().toISOString()
  }
}

function normalizeCircuits(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).map(([name, state]) => ({
    name,
    ...(state && typeof state === 'object' && !Array.isArray(state)
      ? state as Record<string, unknown>
      : { state })
  }))
}

function consoleDiagnostics(list: ProviderList, raw: Record<string, unknown>) {
  const providerHealth: Record<string, unknown> = {}
  for (const provider of list.providers) {
    const runtime = provider.runtimeHealth
    providerHealth[providerKey(provider)] = {
      state: runtime.state,
      last_checked_at: runtime.lastCheckedAt,
      last_status: runtime.lastStatus,
      last_latency_ms: runtime.lastLatencyMs,
      last_error: runtime.lastError,
      windows: {
        '1h': {
          requests: runtime.requests,
          success_rate: runtime.successRate,
          p95_latency_ms: runtime.p95LatencyMs,
          rate_limited: 0
        }
      }
    }
  }
  return {
    accounts: list.providers.flatMap(provider => provider.credentials.map(credential => ({
      id: credential.id,
      active_requests: credential.runtime.activeRequests,
      concurrency_limit: credential.runtime.concurrencyLimit,
      cooldown_until: credential.runtime.cooldownUntil,
      model_cooldowns: credential.runtime.modelCooldowns
    }))),
    queue: { depth: list.accountPool.queueDepth },
    recent_route_decisions: list.accountPool.recentRouteDecisions.map(decision => ({
      at: decision.at,
      model: decision.model,
      selected_account_id: decision.selectedAccountId,
      selected_account_label: decision.selectedAccountLabel,
      outcome: decision.outcome,
      queue_wait_ms: decision.queueWaitMs,
      accounts: decision.accounts
    })),
    provider_health: { providers: providerHealth },
    circuits: normalizeCircuits(raw['circuits']),
    recent_route_errors: raw['recentRouteErrors'] || [],
    credential_protection: {
      enabled: true,
      scheme: 'envelope-v1',
      write_only: true
    },
    deployment: {
      runtime: {
        version: 'central-gateway',
        commit: process.env['AI_EDITOR_BUILD_COMMIT'] || 'development',
        started_at: null,
        entry: 'gateway'
      },
      consistency: { synchronized: true },
      can_deploy: false
    },
    config_snapshots: [],
    account_backups: [],
    automatic_diagnosis: {
      summary: {
        level: list.providers.some(provider =>
          provider.status === 'active' &&
          provider.runtimeHealth.circuitState === 'open'
        ) ? 'warning' : 'healthy',
        conclusion: '中央 Gateway 配置、路由和账号池状态已同步。'
      },
      issues: [],
      account_pool: {
        eligible: list.providers
          .flatMap(provider => provider.credentials)
          .filter(credential => credential.routing?.enabled !== false).length,
        stored_only: list.providers
          .flatMap(provider => provider.credentials)
          .filter(credential => credential.routing?.enabled === false).length,
        cooling: 0,
        model_cooling: 0,
        below_reserve: 0,
        busy: 0
      },
      trends: { operational: { '24h': { account_switches: 0, circuit_opens: 0 } } }
    }
  }
}

async function providerAndCredential(
  service: ProviderService,
  actor: AccessIdentity,
  credentialId: string
): Promise<{ provider: ProviderSummary; credential: ProviderCredential }> {
  const list = await service.list(actor)
  for (const provider of list.providers) {
    const credential = provider.credentials.find(item => item.id === credentialId)
    if (credential) return { provider, credential }
  }
  throw new SafeError({
    code: 'provider_credential_not_found',
    message: '未找到指定账号。',
    statusCode: 404
  })
}

async function replaceCredential(
  service: ProviderService,
  actor: AccessIdentity,
  provider: ProviderSummary,
  secret: string
): Promise<void> {
  if (isMaskedSecret(secret)) return
  for (const credential of provider.credentials) {
    await service.removeCredential(actor, provider.id, credential.id)
  }
  await service.addCredential(actor, provider.id, { secret })
}

async function syncBuiltInProvider(
  service: ProviderService,
  actor: AccessIdentity,
  input: {
    kind: 'openai' | 'deepseek'
    displayName: string
    baseUrl: string
    secret: string
    models: string[]
  }
): Promise<void> {
  const list = await service.list(actor)
  let provider = list.providers.find(item => item.kind === input.kind)
  if (!provider && !input.secret) return
  if (!provider) {
    provider = await service.create(actor, {
      kind: input.kind,
      displayName: input.displayName,
      config: { baseUrl: input.baseUrl, models: input.models }
    })
  } else {
    provider = await service.update(actor, provider.id, {
      displayName: input.displayName,
      config: {
        ...provider.config,
        baseUrl: input.baseUrl
      }
    })
  }
  await replaceCredential(service, actor, provider, input.secret)
}

export function registerFullConsoleRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  providers: ProviderService
  rates: RateService
}): void {
  const authenticateLevel1 = async (request: FastifyRequest, reply: FastifyReply) => {
    await options.authenticate(request, reply)
    identity(request)
  }
  const current = async (request: FastifyRequest) => {
    const actor = identity(request)
    const [providers, models] = await Promise.all([
      options.providers.list(actor),
      options.providers.models(actor)
    ])
    return { actor, providers, models }
  }

  app.get('/admin/api/session', { preHandler: authenticateLevel1 }, request => ({
    account: {
      id: identity(request).accountId,
      role: identity(request).role
    }
  }))

  app.get('/admin/api/config', { preHandler: authenticateLevel1 }, async request => {
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      mode: 'gateway',
      source: 'central'
    }
  })

  app.put('/admin/api/config', { preHandler: authenticateLevel1 }, async request => {
    const actor = identity(request)
    const body = record(request.body)
    await syncBuiltInProvider(options.providers, actor, {
      kind: 'openai',
      displayName: 'OpenAI API',
      baseUrl: text(body['openaiApiBaseUrl']) || DEFAULT_URLS.openai,
      secret: text(body['openaiApiKey']),
      models: ['gpt-5.4', 'gpt-5.4-mini']
    })
    await syncBuiltInProvider(options.providers, actor, {
      kind: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: text(body['upstreamUrl']) || DEFAULT_URLS.deepseek,
      secret: text(body['deepseekApiKey']),
      models: ['deepseek-chat']
    })
    const strategy = text(body['chatgptAccountStrategy'])
    if (strategy) {
      const list = await options.providers.list(actor)
      const chatgpt = list.providers.find(provider => provider.kind === 'chatgpt')
      if (chatgpt) {
        await options.providers.updateAccountStrategy(actor, chatgpt.id, { strategy })
      }
    }
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      reloaded: true,
      mode: 'gateway'
    }
  })

  app.get('/admin/api/models', { preHandler: authenticateLevel1 }, async request => {
    const actor = identity(request)
    const models = await options.providers.models(actor)
    return {
      object: 'list',
      data: models.models
        .filter(model => model.enabled)
        .sort((left, right) => left.priority - right.priority)
        .filter((model, index, values) =>
          values.findIndex(item => item.publicModelId === model.publicModelId) === index
        )
        .map(model => ({
          id: model.publicModelId,
          object: 'model',
          owned_by: model.providerId,
          display_name: model.publicModelId
        }))
    }
  })

  app.get('/admin/api/stats', { preHandler: authenticateLevel1 }, async request => {
    const actor = identity(request)
    const [providers, usage] = await Promise.all([
      options.providers.list(actor),
      options.providers.consoleUsage(actor)
    ])
    return providerStats(providers, usage)
  })

  app.get('/admin/api/diagnostics', { preHandler: authenticateLevel1 }, async request => {
    const actor = identity(request)
    const [providers, diagnostics] = await Promise.all([
      options.providers.list(actor),
      options.providers.diagnostics(actor)
    ])
    return consoleDiagnostics(providers, diagnostics)
  })

  app.get('/admin/api/resilience', { preHandler: authenticateLevel1 }, async request => {
    const raw = await options.providers.diagnostics(identity(request), 'circuits')
    return { circuits: normalizeCircuits(raw['circuits']) }
  })

  app.delete('/admin/api/resilience', { preHandler: authenticateLevel1 }, () => {
    throw safeError('中央 Gateway 暂不支持从管理页面手动清除熔断；系统会自动探测恢复。')
  })

  app.get('/admin/api/error-guide', { preHandler: authenticateLevel1 }, async () => ({
    codes: []
  }))

  app.get('/admin/api/prices', { preHandler: authenticateLevel1 }, async request => {
    const actor = identity(request)
    const [models, rates] = await Promise.all([
      options.providers.models(actor),
      options.rates.visibleRates(actor)
    ])
    const byModel = new Map(rates.map(rate => [rate.modelId, rate]))
    return {
      catalog: {
        notice: '中央 Gateway 模型积分费率；凭据始终只写不回显。',
        updated_at: new Date().toISOString(),
        prices: Object.fromEntries(models.models.map(model => {
          const rate = byModel.get(model.publicModelId)
          return [model.publicModelId, {
            input_credit_per_token: rate?.inputCreditPerToken || '0.001000',
            output_credit_per_token: rate?.outputCreditPerToken || '0.002000',
            multiplier: rate?.multiplier || '1.000000'
          }]
        }))
      }
    }
  })

  app.put('/admin/api/prices', { preHandler: authenticateLevel1 }, () => {
    throw safeError('请在“模型服务”的模型路由中逐项设置积分费率。')
  })

  app.get('/admin/api/costs', { preHandler: authenticateLevel1 }, async request => {
    const list = await options.providers.list(identity(request))
    return {
      today_usd: 0,
      total_usd: 0,
      providers: Object.fromEntries(list.providers.map(provider => [
        providerKey(provider),
        {
          requests: provider.usage.requests,
          input_tokens: provider.usage.inputTokens,
          output_tokens: provider.usage.outputTokens,
          settled_credits: provider.usage.settledCredits,
          remaining_credits: provider.usage.remainingCredits,
          budget: {
            configured: provider.usage.internalBudgetCredits !== null,
            exceeded: provider.usage.remainingCredits?.startsWith('-') === true
          }
        }
      ]))
    }
  })

  app.post('/admin/api/relays', { preHandler: authenticateLevel1 }, async request => {
    const actor = identity(request)
    const body = record(request.body)
    const providerId = text(body['id'])
    const list = await options.providers.list(actor)
    let provider = list.providers.find(item =>
      item.id === providerId && item.kind === 'relay'
    )
    const config = {
      baseUrl: text(body['base_url']),
      models: Array.isArray(body['models']) ? body['models'] : []
    }
    if (provider) {
      provider = await options.providers.update(actor, provider.id, {
        displayName: text(body['name']),
        config
      })
    } else {
      provider = await options.providers.create(actor, {
        kind: 'relay',
        displayName: text(body['name']),
        config
      })
    }
    await replaceCredential(options.providers, actor, provider, text(body['api_key']))
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      message: '中转节点已保存到中央 Gateway。'
    }
  })

  app.delete('/admin/api/relays/:providerId', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const providerId = (request.params as { providerId: string }).providerId
    await options.providers.remove(actor, providerId)
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      message: '中转节点已删除。'
    }
  })

  app.post('/admin/api/chatgpt-accounts/import', {
    preHandler: authenticateLevel1
  }, async request => {
    const body = record(request.body)
    const result = await options.providers.importChatgptAccount(identity(request), {
      authJson: body['authJson'] ?? body['content'],
      label: body['label'],
      routingEnabled: body['routingEnabled']
    })
    const value = await current(request)
    return {
      ...result,
      config: publicConfig(value.providers, value.models),
      message: result.created ? '账号已导入中央 Gateway。' : '账号凭据已更新。'
    }
  })

  app.post('/admin/api/chatgpt-login/start', {
    preHandler: authenticateLevel1
  }, async (request, reply) => {
    const result = await options.providers.startDefaultChatgptLogin(
      identity(request),
      record(request.body)
    )
    await reply.status(202).send(result)
  })

  app.get('/admin/api/chatgpt-login/preflight', {
    preHandler: authenticateLevel1
  }, async () => ({
    available: true,
    source: 'central-gateway',
    recommended: true
  }))

  app.get('/admin/api/chatgpt-login/status', {
    preHandler: authenticateLevel1
  }, request => options.providers.defaultChatgptLoginStatus(identity(request)))

  app.post('/admin/api/chatgpt-login/cancel', {
    preHandler: authenticateLevel1
  }, async () => ({
    status: 'cancelled',
    message: '已停止管理页面轮询；若系统浏览器仍在登录，可直接关闭。'
  }))

  app.patch('/admin/api/chatgpt-accounts/:credentialId/rename', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const credentialId = (request.params as { credentialId: string }).credentialId
    const found = await providerAndCredential(options.providers, actor, credentialId)
    await options.providers.updateCredentialRouting(actor, found.provider.id, credentialId, {
      label: text(record(request.body)['label'])
    })
    const value = await current(request)
    return { config: publicConfig(value.providers, value.models) }
  })

  app.post('/admin/api/chatgpt-accounts/:credentialId/routing', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const credentialId = (request.params as { credentialId: string }).credentialId
    const body = record(request.body)
    const found = await providerAndCredential(options.providers, actor, credentialId)
    await options.providers.updateCredentialRouting(actor, found.provider.id, credentialId, {
      ...(body['enabled'] === undefined
        ? {}
        : { routingEnabled: body['enabled'] === true }),
      ...(body['weight'] === undefined
        ? {}
        : { routingWeight: body['weight'] }),
      ...(body['lowQuotaThreshold'] === undefined && body['low_quota_threshold'] === undefined
        ? {}
        : {
            lowQuotaThreshold:
              body['lowQuotaThreshold'] ?? body['low_quota_threshold']
          }),
      ...(body['dailyRequestLimit'] === undefined && body['daily_request_limit'] === undefined
        ? {}
        : {
            dailyRequestLimit:
              body['dailyRequestLimit'] ?? body['daily_request_limit']
          }),
      ...(body['dailyTokenLimit'] === undefined && body['daily_token_limit'] === undefined
        ? {}
        : {
            dailyTokenLimit:
              body['dailyTokenLimit'] ?? body['daily_token_limit']
          }),
      ...(body['reservedModels'] === undefined && body['reserved_models'] === undefined
        ? {}
        : { reservedModels: body['reservedModels'] ?? body['reserved_models'] })
    })
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      message: '账号路由设置已更新。'
    }
  })

  app.post('/admin/api/chatgpt-accounts/:credentialId/refresh-usage', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const credentialId = (request.params as { credentialId: string }).credentialId
    const found = await providerAndCredential(options.providers, actor, credentialId)
    await options.providers.refreshCredentialUsage(actor, found.provider.id, credentialId)
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      message: '账号额度已同步。'
    }
  })

  app.post('/admin/api/chatgpt-accounts/refresh-usage-all', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const list = await options.providers.list(actor)
    const errors: string[] = []
    for (const provider of list.providers.filter(item => item.kind === 'chatgpt')) {
      for (const credential of provider.credentials) {
        try {
          await options.providers.refreshCredentialUsage(
            actor,
            provider.id,
            credential.id
          )
        } catch {
          errors.push(credential.id)
        }
      }
    }
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      result: { errors },
      message: errors.length
        ? `已完成同步，${errors.length} 个账号需要重新登录或稍后重试。`
        : '全部账号额度已同步。'
    }
  })

  app.post('/admin/api/chatgpt-accounts/check-all', {
    preHandler: authenticateLevel1
  }, async request => {
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      message: '已根据中央运行状态检查全部账号。'
    }
  })

  app.post('/admin/api/chatgpt-accounts/reorder', {
    preHandler: authenticateLevel1
  }, () => {
    throw safeError('中央 Gateway 使用路由权重和选择策略，不使用本机账号拖拽顺序。')
  })

  app.delete('/admin/api/chatgpt-accounts/:credentialId', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const credentialId = (request.params as { credentialId: string }).credentialId
    const found = await providerAndCredential(options.providers, actor, credentialId)
    await options.providers.removeCredential(actor, found.provider.id, credentialId)
    const value = await current(request)
    return {
      config: publicConfig(value.providers, value.models),
      message: '账号已从中央 Gateway 移除。'
    }
  })

  app.post('/admin/api/ping', { preHandler: authenticateLevel1 }, async request => {
    const body = record(request.body)
    const requestedType = text(body['type'])
    const relayId = text(body['relayId'])
    const actor = identity(request)
    const list = await options.providers.list(actor)
    const provider = list.providers.find(item => {
      if (requestedType === 'relay') return item.kind === 'relay' && item.id === relayId
      return providerKey(item) === requestedType
    })
    if (!provider) {
      return {
        ok: false,
        latency: 0,
        source: 'provider-active-probe',
        error: '通道未配置。'
      }
    }
    const result = await options.providers.probe(actor, provider.id)
    return {
      ...result,
      error: result.ok ? null : result.error || '通道主动探测失败。'
    }
  })

  app.post('/admin/api/ping-all', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const list = await options.providers.list(actor)
    const probed = await Promise.all(list.providers.map(async provider => [
      providerKey(provider),
      await options.providers.probe(actor, provider.id)
    ] as const))
    const results = Object.fromEntries(probed)
    return {
      results,
      allOk: Object.values(results).every(result => result.ok)
    }
  })

  for (const route of [
    '/admin/api/chatgpt-accounts/import-current',
    '/admin/api/chatgpt-accounts/refresh-reset-credits-all',
    '/admin/api/codex/restart',
    '/admin/api/runtime-repair',
    '/admin/api/deploy-update',
    '/admin/api/proxy/restart',
    '/admin/api/account-backups/restore',
    '/admin/api/config-rollback'
  ]) {
    app.post(route, { preHandler: authenticateLevel1 }, () => {
      throw safeError('该操作仅适用于本机 standalone Proxy，不会作用于中央 Gateway。')
    })
  }

  app.delete('/admin/api/stats', { preHandler: authenticateLevel1 }, () => {
    throw safeError('中央用量与审计记录不可从客户端管理页面清空。')
  })

  app.delete('/admin/api/provider-health', {
    preHandler: authenticateLevel1
  }, () => {
    throw safeError('中央 Provider 健康历史不可从客户端管理页面清空。')
  })

  app.get('/admin/api/runtime-info', {
    preHandler: authenticateLevel1
  }, async () => ({
    runtime: {
      version: 'central-gateway',
      commit: process.env['AI_EDITOR_BUILD_COMMIT'] || 'development',
      started_at: null,
      entry: 'gateway'
    },
    consistency: { synchronized: true }
  }))

  app.get('/admin/api/config-snapshots', {
    preHandler: authenticateLevel1
  }, async () => ({ snapshots: [] }))

  app.get('/admin/api/account-backups', {
    preHandler: authenticateLevel1
  }, async () => ({ backups: [] }))

  app.get('/admin/api/diagnosis', {
    preHandler: authenticateLevel1
  }, async request => {
    const actor = identity(request)
    const [providers, diagnostics] = await Promise.all([
      options.providers.list(actor),
      options.providers.diagnostics(actor)
    ])
    return consoleDiagnostics(providers, diagnostics).automatic_diagnosis
  })
}
