import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import { redactValue } from '../common/redaction.js'
import type { GatewayConfig } from '../config.js'
import {
	ProviderRepository,
	type ModelRouteRecord,
	type ProviderCredentialRecord,
	type ProviderKind,
	type ProviderRecord,
	type ProviderUsageSummary
} from '../db/repositories/provider-repository.js'
import type { AccessIdentity } from '../auth/types.js'
import type {
	AccountRoutingStrategy,
	GatewayProviderRuntimeConfiguration,
	ProviderRouteAdapter,
	SafeAccountPoolAccount,
	SafeAccountPoolSnapshot
} from '../routing/standalone-route-adapter.js'
import {
  assertCredentialStorageAllowed,
  PLAINTEXT_STORAGE_WARNING
} from './credential-policy.js'
import type { ChatgptLoginCoordinator } from './chatgpt-login-service.js'
import {
	formatCredits,
	normalizeCredits,
	parseCredits,
	percentage
} from '../credits/decimal.js'

const DEFAULTS = {
  deepseekUrl: 'https://api.deepseek.com/anthropic/v1/messages',
  openaiBaseUrl: 'https://api.openai.com/v1',
  chatgptResponsesUrl: 'https://chatgpt.com/backend-api/codex/responses'
}

const DEFAULT_CHATGPT_PROVIDER_NAME = 'ChatGPT 订阅池'
const DEFAULT_CHATGPT_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini'
] as const

const ACCOUNT_ROUTING_STRATEGIES: readonly AccountRoutingStrategy[] = [
	'priority',
	'round-robin',
	'headroom',
	'least-used',
	'latency',
	'reliable',
	'weighted',
	'random',
	'lkgp'
]

function requiredText(value: unknown, name: string, max = 240): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max) {
    throw new SafeError({
      code: 'invalid_request',
      message: `${name} 无效。`,
      statusCode: 400
    })
  }
  return result
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new SafeError({
      code: 'invalid_request',
      message: '请求字段无效。',
      statusCode: 400
    })
  }
  return value.trim() || undefined
}

interface ParsedChatgptAuthJson {
  readonly serialized: string
  readonly accountId: string
}

function parseChatgptAuthJson(value: unknown): ParsedChatgptAuthJson {
  const raw = requiredText(value, 'auth.json', 256 * 1024)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new SafeError({
      code: 'invalid_chatgpt_auth_json',
      message: 'auth.json 不是有效的 JSON。',
      statusCode: 400
    })
  }
  const tokens = asObject(parsed['tokens'])
  const accessToken = optionalText(tokens['access_token'], 64 * 1024)
  const refreshToken = optionalText(tokens['refresh_token'], 64 * 1024)
  const accountId = optionalText(tokens['account_id'], 512)
  if (!accessToken || !refreshToken || !accountId) {
    throw new SafeError({
      code: 'invalid_chatgpt_auth_json',
      message: 'auth.json 缺少 access_token、refresh_token 或 account_id。',
      statusCode: 400
    })
  }
  return {
    serialized: JSON.stringify(parsed),
    accountId
  }
}

function chatgptCredentialAccountId(
  credential: ProviderCredentialRecord
): string | undefined {
  try {
    const parsed = JSON.parse(credential.secretPayload) as Record<string, unknown>
    const tokens = asObject(parsed['tokens'])
    const value = tokens['account_id']
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

function accountIdPreview(accountId: string): string {
  if (accountId.length <= 12) return accountId
  return `${accountId.slice(0, 8)}…${accountId.slice(-4)}`
}

function safeChatgptAccountLabel(value: unknown, fallback: string): string {
  const label = typeof value === 'string' ? value.trim() : ''
  return label &&
    !label.includes('\uFFFD') &&
    !/\?{2,}/.test(label)
    ? label
    : fallback
}

function providerKind(value: unknown): ProviderKind {
  if (!['chatgpt', 'openai', 'deepseek', 'relay'].includes(String(value))) {
    throw new SafeError({
      code: 'invalid_provider_kind',
      message: 'Provider 类型无效。',
      statusCode: 400
    })
  }
  return value as ProviderKind
}

function safeUrl(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new SafeError({
      code: 'invalid_provider_url',
      message: 'Provider 地址无效。',
      statusCode: 400
    })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SafeError({
      code: 'invalid_provider_url',
      message: 'Provider 地址必须使用 HTTP(S) 且不能包含凭据。',
      statusCode: 400
    })
  }
  return url.toString().replace(/\/+$/, '')
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
}

function accountRoutingStrategy(value: unknown): AccountRoutingStrategy {
	const normalized = String(value || '').trim().toLowerCase()
	return ACCOUNT_ROUTING_STRATEGIES.includes(normalized as AccountRoutingStrategy)
		? normalized as AccountRoutingStrategy
		: 'headroom'
}

function safeStringList(value: unknown, max = 50): string[] {
	return Array.isArray(value)
		? [...new Set(value
			.map(item => String(item).trim())
			.filter(item => /^[A-Za-z0-9._:-]{1,160}$/.test(item)))]
			.slice(0, max)
		: []
}

function credentialSettingsMap(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const source = asObject(config['credentialSettings'])
	return Object.fromEntries(
		Object.entries(source)
			.filter(([id, value]) => /^[A-Za-z0-9_-]{1,160}$/.test(id) && Object.keys(asObject(value)).length)
			.slice(0, 500)
			.map(([id, value]) => [id, asObject(value)])
	)
}

function sanitizeCredentialSettings(value: unknown): Record<string, Record<string, unknown>> {
	const source = credentialSettingsMap({ credentialSettings: value })
	return Object.fromEntries(Object.entries(source).map(([id, raw]) => {
		const label = typeof raw['label'] === 'string' ? raw['label'].trim().slice(0, 80) : ''
		return [id, {
			...(label ? { label } : {}),
			routingEnabled: raw['routingEnabled'] !== false,
			routingWeight: Math.max(1, Math.min(100, Math.floor(Number(raw['routingWeight']) || 1))),
			lowQuotaThreshold: Math.max(
				0,
				Math.min(100, Number.isFinite(Number(raw['lowQuotaThreshold']))
					? Number(raw['lowQuotaThreshold'])
					: 10)
			),
			dailyRequestLimit: Math.max(0, Math.floor(Number(raw['dailyRequestLimit']) || 0)),
			dailyTokenLimit: Math.max(0, Math.floor(Number(raw['dailyTokenLimit']) || 0)),
			reservedModels: safeStringList(raw['reservedModels'])
		}]
	}))
}

function internalBudgetCredits(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null
	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new SafeError({
			code: 'invalid_provider_budget',
			message: 'Provider 内部预算无效。',
			statusCode: 400
		})
	}
	try {
		return normalizeCredits(value)
	} catch {
		throw new SafeError({
			code: 'invalid_provider_budget',
			message: 'Provider 内部预算必须是最多六位小数的非负积分。',
			statusCode: 400
		})
	}
}

function sanitizeConfig(kind: ProviderKind, value: unknown): Record<string, unknown> {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const models = Array.isArray(input['models'])
    ? [...new Set(input['models']
      .map(model => String(model).trim())
      .filter(model => /^[A-Za-z0-9._:-]{1,160}$/.test(model)))]
      .slice(0, 100)
    : []
  const fallback = kind === 'openai'
    ? DEFAULTS.openaiBaseUrl
    : kind === 'deepseek'
      ? DEFAULTS.deepseekUrl
      : kind === 'chatgpt'
        ? DEFAULTS.chatgptResponsesUrl
        : ''
	return {
    ...(kind === 'relay' || input['baseUrl']
      ? { baseUrl: safeUrl(input['baseUrl'], fallback) }
      : {}),
		models,
		...(internalBudgetCredits(input['internalBudgetCredits']) === null
			? {}
			: { internalBudgetCredits: internalBudgetCredits(input['internalBudgetCredits']) }),
		...(kind === 'chatgpt'
			? {
				accountRoutingStrategy: accountRoutingStrategy(input['accountRoutingStrategy']),
				credentialSettings: sanitizeCredentialSettings(input['credentialSettings'])
			}
			: {})
	}
}

function maskSecret(secret: string): string {
  const suffix = secret.slice(-4)
  const prefix = /^[A-Za-z0-9_-]{2,4}/.exec(secret)?.[0].slice(0, 3) || '***'
  return `${prefix}...${suffix}`
}

interface SafeProviderRuntime {
	readonly state: string
	readonly circuitState: string
	readonly lastCheckedAt: string | null
	readonly lastStatus: number | null
	readonly lastLatencyMs: number | null
	readonly lastError: string | null
	readonly requests: number
	readonly successRate: number | null
	readonly p95LatencyMs: number
}

function providerRuntimeKey(provider: ProviderRecord): string {
	if (provider.kind === 'chatgpt') return 'chatgpt-sub'
	if (provider.kind === 'openai') return 'openai-api'
	if (provider.kind === 'relay') return `relay:${provider.id}`
	return 'deepseek'
}

function providerRuntime(
	provider: ProviderRecord,
	diagnostics?: Record<string, unknown>
): SafeProviderRuntime {
	const key = providerRuntimeKey(provider)
	const providerRoot = asObject(asObject(diagnostics?.['providers'])['providers'])
	const health = asObject(providerRoot[key])
	const windows = asObject(health['windows'])
	const hour = asObject(windows['1h'])
	const circuits = Array.isArray(diagnostics?.['circuits'])
		? diagnostics?.['circuits'].map(asObject)
		: []
	const circuit = circuits.find(item => item['name'] === key) || {}
	const numberOrNull = (value: unknown) => {
		if (value === null || value === undefined || value === '') return null
		const result = Number(value)
		return Number.isFinite(result) ? result : null
	}
	const textOrNull = (value: unknown) =>
		typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : null
	return {
		state: textOrNull(health['state']) || 'unknown',
		circuitState: textOrNull(circuit['state']) || 'closed',
		lastCheckedAt: textOrNull(health['last_checked_at']),
		lastStatus: numberOrNull(health['last_status']),
		lastLatencyMs: numberOrNull(health['last_latency_ms']),
		lastError: textOrNull(health['last_error']),
		requests: Math.max(0, Number(hour['requests']) || 0),
		successRate: numberOrNull(hour['success_rate']),
		p95LatencyMs: Math.max(0, Number(hour['p95_latency_ms']) || 0)
	}
}

function safeCredential(
	record: ProviderCredentialRecord,
	account?: SafeAccountPoolAccount,
	providerHealth?: SafeProviderRuntime
) {
	return {
		id: record.id,
		maskedPreview: maskSecret(record.secretPayload),
		storageFormat: record.storageKind,
		keyVersion: record.keyVersion,
		credentialVersion: record.credentialVersion,
		updatedAt: record.updatedAt,
		lastUsedAt: account?.health.lastRequestAt || providerHealth?.lastCheckedAt || null,
		label: account?.label || null,
		accountIdPreview: account?.accountIdPreview || null,
		planType: account?.planType || null,
		status: account?.status || (
			providerHealth?.circuitState === 'open'
				? 'circuit_open'
				: providerHealth?.state || 'unknown'
		),
		routing: account ? {
			enabled: account.routingEnabled,
			weight: account.routingWeight,
			lowQuotaThreshold: account.lowQuotaThreshold,
			dailyRequestLimit: account.dailyRequestLimit,
			dailyTokenLimit: account.dailyTokenLimit,
			reservedModels: account.reservedModels
		} : null,
		quota: account?.quota || {
			source: 'unavailable',
			primary: null,
			secondary: null,
			updatedAt: null,
			syncStatus: 'unavailable',
			syncError: null
		},
		runtime: account?.runtime || {
			activeRequests: 0,
			concurrencyLimit: 0,
			cooldownUntil: null,
			modelCooldowns: 0
		},
		health: account?.health || {
			requests: providerHealth?.requests || 0,
			successRate: providerHealth?.successRate ?? null,
			p95LatencyMs: providerHealth?.p95LatencyMs || 0,
			rateLimited: 0,
			lastRequestAt: providerHealth?.lastCheckedAt || null,
			lastErrorType: providerHealth?.lastStatus ? `http_${providerHealth.lastStatus}` : null,
			lastErrorMessage: providerHealth?.lastError || null
		}
	}
}

function safeProvider(
	provider: ProviderRecord,
	credentials: readonly ProviderCredentialRecord[],
	accountPool?: SafeAccountPoolSnapshot,
	diagnostics?: Record<string, unknown>,
	usage?: ProviderUsageSummary
) {
	const accounts = new Map((accountPool?.accounts || []).map(account => [account.id, account]))
	const runtime = providerRuntime(provider, diagnostics)
	const settledCredits = usage?.settledCredits || '0.000000'
	const budget = typeof provider.config['internalBudgetCredits'] === 'string'
		? provider.config['internalBudgetCredits']
		: null
	const remainingCredits = budget === null
		? null
		: formatCredits(parseCredits(budget) - parseCredits(settledCredits))
	return {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    status: provider.status,
    config: provider.config,
    version: provider.version,
    updatedAt: provider.updatedAt,
		credentials: credentials
			.filter(credential => credential.providerId === provider.id)
			.map(credential => safeCredential(
				credential,
				accounts.get(credential.id),
				runtime
			)),
		runtimeHealth: runtime,
		usage: {
			requests: usage?.requests || 0,
			inputTokens: usage?.inputTokens || 0,
			outputTokens: usage?.outputTokens || 0,
			settledCredits,
			internalBudgetCredits: budget,
			remainingCredits,
			usedPercent: budget === null ? null : percentage(settledCredits, budget),
			lastUsedAt: usage?.lastUsedAt || null
		},
    plaintextWarning: credentials.some(credential =>
      credential.providerId === provider.id &&
      credential.storageKind === 'plaintext-v1'
    ) ? PLAINTEXT_STORAGE_WARNING : null
  }
}

function publicModelId(
  kind: ProviderKind,
  providerId: string,
  upstreamModel: string
): string {
  if (kind === 'openai') return `openai-api-${upstreamModel}`
  if (kind === 'relay') return `relay-${providerId}-${upstreamModel}`
  return upstreamModel
}

function parseChatgptCredential(
  provider: ProviderRecord,
  credential: ProviderCredentialRecord
): Record<string, unknown> | null {
	try {
    const parsed = JSON.parse(credential.secretPayload) as Record<string, unknown>
    const source = parsed['tokens'] && typeof parsed['tokens'] === 'object'
      ? parsed['tokens'] as Record<string, unknown>
      : parsed
    const accessToken = source['access_token'] || source['accessToken']
    const refreshToken = source['refresh_token'] || source['refreshToken']
		if (!accessToken && !refreshToken) return null
		const settings = credentialSettingsMap(provider.config)[credential.id] || {}
		return {
			id: credential.id,
			label: safeChatgptAccountLabel(settings['label'], provider.displayName),
			account_id: String(source['account_id'] || source['accountId'] || credential.id),
			access_token: accessToken || '',
			refresh_token: refreshToken || '',
			id_token: source['id_token'] || source['idToken'] || '',
			expires_at: source['expires_at'] || source['expiresAt'] || null,
			routing_enabled: settings['routingEnabled'] !== false,
			routing_weight: Math.max(1, Math.min(100, Number(settings['routingWeight']) || 1)),
			low_quota_threshold: Math.max(
				0,
				Math.min(100, Number.isFinite(Number(settings['lowQuotaThreshold']))
					? Number(settings['lowQuotaThreshold'])
					: 10)
			),
			daily_request_limit: Math.max(0, Math.floor(Number(settings['dailyRequestLimit']) || 0)),
			daily_token_limit: Math.max(0, Math.floor(Number(settings['dailyTokenLimit']) || 0)),
			reserved_models: safeStringList(settings['reservedModels']),
			status: 'active',
			credential_version: credential.credentialVersion
		}
  } catch {
    return null
  }
}

export class ProviderService {
  private activeChatgptLoginProviderId: string | undefined

  constructor(
    private readonly repository: ProviderRepository,
    private readonly adapter: ProviderRouteAdapter,
    private readonly config: GatewayConfig,
    private readonly clock: Clock,
    private readonly ids: IdSource,
    private readonly chatgptLogin: ChatgptLoginCoordinator
  ) {}

  async initialize(): Promise<void> {
    assertCredentialStorageAllowed(
      this.config,
      await this.repository.countPlaintextCredentials()
    )
    // Preserve an explicitly supplied isolated standalone environment until
    // the Gateway database becomes the Provider source of truth. Once any
    // database Provider exists, all subsequent changes (including deleting
    // the last Provider) are applied dynamically from the database.
    if ((await this.repository.listProviders()).length > 0) {
      await this.applyRuntimeConfiguration()
    }
  }

  async recoverWorkerRuntimeConfiguration(): Promise<boolean> {
    if (
      !this.adapter.providerRuntimeStatus ||
      !this.adapter.configureProviders
    ) {
      return false
    }
    const status = await this.adapter.providerRuntimeStatus()
    if (status.enabled || status.accountCount > 0 || status.modelCount > 0) {
      return false
    }
    const [providers, credentials] = await Promise.all([
      this.repository.listProviders(),
      this.repository.listCredentials()
    ])
    const activeChatgptProviderIds = new Set(providers
      .filter(provider =>
        provider.kind === 'chatgpt' &&
        provider.status === 'active'
      )
      .map(provider => provider.id))
    if (!credentials.some(credential =>
      activeChatgptProviderIds.has(credential.providerId)
    )) {
      return false
    }
    await this.applyRuntimeConfiguration()
    return true
  }

	async list(identity: AccessIdentity) {
		await this.requireLevel1(identity, 'provider.list', null)
		const [providers, credentials, accountPool, diagnostics, usage] = await Promise.all([
			this.repository.listProviders(),
			this.repository.listCredentials(),
			this.adapter.safeAccountPool?.(),
			this.adapter.safeDiagnostics?.(),
			this.repository.listProviderUsageSummaries()
		])
		return {
      warning: credentials.some(item => item.storageKind === 'plaintext-v1')
        ? PLAINTEXT_STORAGE_WARNING
        : null,
			accountPool: accountPool || {
				strategy: 'headroom',
				accounts: [],
				queueDepth: 0,
				recentRouteDecisions: []
			},
			providers: providers.map(provider =>
				safeProvider(
					provider,
					credentials,
					accountPool,
					diagnostics,
					usage.find(item => item.providerId === provider.id)
				)
			)
    }
  }

  async create(identity: AccessIdentity, body: Record<string, unknown>) {
    await this.requireLevel1(identity, 'provider.create', null)
    const kind = providerKind(body['kind'])
    const now = this.clock.now().toISOString()
    const provider: ProviderRecord = {
      id: this.ids.opaque('provider'),
      kind,
      displayName: requiredText(body['displayName'], 'Provider 名称'),
      status: body['status'] === 'disabled' ? 'disabled' : 'active',
      config: sanitizeConfig(kind, body['config']),
      createdAt: now,
      updatedAt: now,
      version: 1
    }
    await this.repository.inTransaction(async repository => {
      await repository.insertProvider(provider)
      for (const [index, model] of (provider.config['models'] as string[]).entries()) {
        await repository.upsertModelRoute({
          id: this.ids.opaque('route'),
          publicModelId: publicModelId(kind, provider.id, model),
          providerId: provider.id,
          upstreamModelId: model,
          priority: index + 1,
          enabled: true,
          policy: {},
          createdAt: now,
          updatedAt: now,
          version: 1
        })
      }
      await this.audit(repository, identity, 'provider.create', 'provider', provider.id, 'allowed')
    })
    await this.applyRuntimeConfiguration()
		return safeProvider(provider, [])
  }

  async update(
    identity: AccessIdentity,
    providerId: string,
    body: Record<string, unknown>
  ) {
    await this.requireLevel1(identity, 'provider.update', providerId)
    const current = await this.requireProvider(providerId)
    const changed = await this.repository.updateProvider(providerId, {
      ...(body['displayName'] === undefined
        ? {}
        : { displayName: requiredText(body['displayName'], 'Provider 名称') }),
      ...(body['status'] === undefined
        ? {}
        : {
            status: body['status'] === 'active'
              ? 'active' as const
              : body['status'] === 'disabled'
                ? 'disabled' as const
                : (() => {
                    throw new SafeError({
                      code: 'invalid_provider_status',
                      message: 'Provider 状态无效。',
                      statusCode: 400
                    })
                  })()
          }),
			...(body['config'] === undefined
				? {}
				: {
					config: sanitizeConfig(current.kind, {
						...current.config,
						...asObject(body['config'])
					})
				}),
      updatedAt: this.clock.now().toISOString()
    })
    if (!changed) throw this.notFound()
    await this.recordAllowed(identity, 'provider.update', 'provider', providerId)
    await this.applyRuntimeConfiguration()
    return this.provider(identity, providerId)
  }

	async provider(identity: AccessIdentity, providerId: string) {
    await this.requireLevel1(identity, 'provider.read', providerId)
    const provider = await this.requireProvider(providerId)
		return safeProvider(
			provider,
			await this.repository.listCredentials(providerId),
			await this.adapter.safeAccountPool?.(),
			await this.adapter.safeDiagnostics?.(),
			(await this.repository.listProviderUsageSummaries(providerId))[0]
		)
	}

  async remove(identity: AccessIdentity, providerId: string): Promise<void> {
    await this.requireLevel1(identity, 'provider.delete', providerId)
    if (!await this.repository.deleteProvider(providerId)) throw this.notFound()
    await this.recordAllowed(identity, 'provider.delete', 'provider', providerId)
    await this.applyRuntimeConfiguration()
  }

  async addCredential(
    identity: AccessIdentity,
    providerId: string,
    body: Record<string, unknown>
  ) {
    await this.requireLevel1(identity, 'provider.credential.create', providerId)
    await this.requireProvider(providerId)
    const secret = requiredText(body['secret'], 'Provider 凭据', 10_000)
    const now = this.clock.now().toISOString()
    const credential: ProviderCredentialRecord = {
      id: this.ids.opaque('cred'),
      providerId,
      storageKind: 'plaintext-v1',
      secretPayload: secret,
      keyVersion: null,
      credentialVersion: 1,
      createdAt: now,
      updatedAt: now
    }
    await this.repository.insertCredential(credential)
    await this.recordAllowed(
      identity,
      'provider.credential.create',
      'provider_credential',
      credential.id
    )
    await this.applyRuntimeConfiguration()
    const stored = (await this.repository.listCredentials(providerId))
      .find(item => item.id === credential.id)
    if (!stored) throw this.notFound()
    return {
      ...safeCredential(stored),
      warning: stored.storageKind === 'plaintext-v1'
        ? PLAINTEXT_STORAGE_WARNING
        : null
    }
  }

  async importChatgptAccount(
    identity: AccessIdentity,
    body: Record<string, unknown>
  ) {
    await this.requireLevel1(identity, 'provider.chatgpt_account.import', null)
    const auth = parseChatgptAuthJson(body['authJson'] ?? body['auth_json'])
    const label = optionalText(body['label'], 80)
    if (body['routingEnabled'] !== undefined && typeof body['routingEnabled'] !== 'boolean') {
      throw new SafeError({
        code: 'invalid_request',
        message: 'routingEnabled 必须是布尔值。',
        statusCode: 400
      })
    }
    const requestedRoutingEnabled = body['routingEnabled'] !== false
    const now = this.clock.now().toISOString()
    let result: {
      providerId: string
      credentialId: string
      created: boolean
      routingEnabled: boolean
    } | undefined

    await this.repository.inTransaction(async repository => {
      const providers = await repository.listProviders()
      const providerById = new Map(providers.map(provider => [provider.id, provider]))
      const credentials = await repository.listCredentials()
      const duplicate = credentials.find(credential =>
        providerById.get(credential.providerId)?.kind === 'chatgpt' &&
        chatgptCredentialAccountId(credential) === auth.accountId
      )

      let provider = duplicate
        ? providerById.get(duplicate.providerId)
        : providers.find(item => item.kind === 'chatgpt' && item.status === 'active') ||
          providers.find(item => item.kind === 'chatgpt')
      let providerCreated = false
      if (!provider) {
        providerCreated = true
        provider = {
          id: this.ids.opaque('provider'),
          kind: 'chatgpt',
          displayName: DEFAULT_CHATGPT_PROVIDER_NAME,
          status: 'active',
          config: sanitizeConfig('chatgpt', { models: DEFAULT_CHATGPT_MODELS }),
          createdAt: now,
          updatedAt: now,
          version: 1
        }
        await repository.insertProvider(provider)
        for (const [index, model] of DEFAULT_CHATGPT_MODELS.entries()) {
          await repository.upsertModelRoute({
            id: this.ids.opaque('route'),
            publicModelId: model,
            providerId: provider.id,
            upstreamModelId: model,
            priority: index + 1,
            enabled: true,
            policy: {},
            createdAt: now,
            updatedAt: now,
            version: 1
          })
        }
      }

      const credentialId = duplicate?.id || this.ids.opaque('cred')
      if (duplicate) {
        if (!await repository.updateCredential(provider.id, credentialId, {
          storageKind: 'plaintext-v1',
          secretPayload: auth.serialized,
          updatedAt: now
        })) {
          throw this.notFound()
        }
      } else {
        await repository.insertCredential({
          id: credentialId,
          providerId: provider.id,
          storageKind: 'plaintext-v1',
          secretPayload: auth.serialized,
          keyVersion: null,
          credentialVersion: 1,
          createdAt: now,
          updatedAt: now
        })
      }

      const settings = credentialSettingsMap(provider.config)
      const current = settings[credentialId] || {}
      const routingEnabled = body['routingEnabled'] === undefined
        ? duplicate
          ? current['routingEnabled'] !== false
          : true
        : requestedRoutingEnabled
      settings[credentialId] = {
        ...(current as Record<string, unknown>),
        ...(label ? { label } : {}),
        routingEnabled,
        routingWeight: Math.max(1, Math.min(100, Number(current['routingWeight']) || 1)),
        lowQuotaThreshold: Math.max(
          0,
          Math.min(100, Number.isFinite(Number(current['lowQuotaThreshold']))
            ? Number(current['lowQuotaThreshold'])
            : 10)
        ),
        dailyRequestLimit: Math.max(0, Math.floor(Number(current['dailyRequestLimit']) || 0)),
        dailyTokenLimit: Math.max(0, Math.floor(Number(current['dailyTokenLimit']) || 0)),
        reservedModels: safeStringList(current['reservedModels'])
      }
      await repository.updateProvider(provider.id, {
        config: sanitizeConfig('chatgpt', {
          ...provider.config,
          credentialSettings: settings
        }),
        updatedAt: now
      })
      await this.audit(
        repository,
        identity,
        'provider.chatgpt_account.import',
        'provider_credential',
        credentialId,
        'allowed',
        {
          created: !duplicate,
          providerCreated,
          routingEnabled
        }
      )
      result = {
        providerId: provider.id,
        credentialId,
        created: !duplicate,
        routingEnabled
      }
    })

    await this.applyRuntimeConfiguration()
    if (!result) throw new Error('ChatGPT account import transaction produced no result')
    return {
      ...result,
      accountIdPreview: accountIdPreview(auth.accountId),
      warning: null
    }
  }

	async removeCredential(
    identity: AccessIdentity,
    providerId: string,
    credentialId: string
  ): Promise<void> {
    await this.requireLevel1(identity, 'provider.credential.delete', providerId)
		const provider = await this.requireProvider(providerId)
		if (!await this.repository.deleteCredential(providerId, credentialId)) {
			throw this.notFound()
		}
		const settings = credentialSettingsMap(provider.config)
		delete settings[credentialId]
		await this.repository.updateProvider(providerId, {
			config: sanitizeConfig(provider.kind, {
				...provider.config,
				credentialSettings: settings
			}),
			updatedAt: this.clock.now().toISOString()
		})
    await this.recordAllowed(
      identity,
      'provider.credential.delete',
      'provider_credential',
      credentialId
    )
		await this.applyRuntimeConfiguration()
	}

	async updateCredentialRouting(
		identity: AccessIdentity,
		providerId: string,
		credentialId: string,
		body: Record<string, unknown>
	) {
		await this.requireLevel1(identity, 'provider.credential.routing.update', providerId)
		const provider = await this.requireChatgptProvider(providerId)
		const credential = (await this.repository.listCredentials(providerId))
			.find(item => item.id === credentialId)
		if (!credential) throw this.notFound()
		const currentSettings = credentialSettingsMap(provider.config)
		const current = currentSettings[credentialId] || {}
		const label = body['label'] === undefined
			? current['label']
			: requiredText(body['label'], '账号名称', 80)
		const routingEnabled = body['routingEnabled'] === undefined
			? current['routingEnabled'] !== false
			: body['routingEnabled'] === true
		const numberField = (
			name: string,
			currentValue: unknown,
			min: number,
			max: number
		) => {
			if (body[name] === undefined) return Math.max(min, Math.min(max, Number(currentValue) || min))
			const value = Number(body[name])
			if (!Number.isFinite(value) || value < min || value > max) {
				throw new SafeError({
					code: 'invalid_account_routing_policy',
					message: '账号路由策略参数无效。',
					statusCode: 400
				})
			}
			return Math.floor(value)
		}
		currentSettings[credentialId] = {
			...(label ? { label } : {}),
			routingEnabled,
			routingWeight: numberField('routingWeight', current['routingWeight'], 1, 100),
			lowQuotaThreshold: numberField(
				'lowQuotaThreshold',
				current['lowQuotaThreshold'] ?? 10,
				0,
				100
			),
			dailyRequestLimit: numberField(
				'dailyRequestLimit',
				current['dailyRequestLimit'],
				0,
				1_000_000_000
			),
			dailyTokenLimit: numberField(
				'dailyTokenLimit',
				current['dailyTokenLimit'],
				0,
				1_000_000_000_000
			),
			reservedModels: body['reservedModels'] === undefined
				? safeStringList(current['reservedModels'])
				: safeStringList(body['reservedModels'])
		}
		await this.repository.updateProvider(providerId, {
			config: sanitizeConfig(provider.kind, {
				...provider.config,
				credentialSettings: currentSettings
			}),
			updatedAt: this.clock.now().toISOString()
		})
		await this.recordAllowed(
			identity,
			'provider.credential.routing.update',
			'provider_credential',
			credentialId
		)
		await this.applyRuntimeConfiguration()
		return this.provider(identity, providerId)
	}

	async updateAccountStrategy(
		identity: AccessIdentity,
		providerId: string,
		body: Record<string, unknown>
	) {
		await this.requireLevel1(identity, 'provider.account_strategy.update', providerId)
		await this.requireChatgptProvider(providerId)
		const requested = String(body['strategy'] || '').trim().toLowerCase()
		if (!ACCOUNT_ROUTING_STRATEGIES.includes(requested as AccountRoutingStrategy)) {
			throw new SafeError({
				code: 'invalid_account_routing_strategy',
				message: '账号池路由策略无效。',
				statusCode: 400
			})
		}
		const now = this.clock.now().toISOString()
		const chatgptProviders = (await this.repository.listProviders())
			.filter(item => item.kind === 'chatgpt')
		for (const item of chatgptProviders) {
			await this.repository.updateProvider(item.id, {
				config: sanitizeConfig(item.kind, {
					...item.config,
					accountRoutingStrategy: requested
				}),
				updatedAt: now
			})
		}
		await this.recordAllowed(
			identity,
			'provider.account_strategy.update',
			'provider',
			providerId
		)
		await this.applyRuntimeConfiguration()
		return this.provider(identity, providerId)
	}

	async updateInternalBudget(
		identity: AccessIdentity,
		providerId: string,
		body: Record<string, unknown>
	) {
		await this.requireLevel1(identity, 'provider.internal_budget.update', providerId)
		const provider = await this.requireProvider(providerId)
		const budget = internalBudgetCredits(body['internalBudgetCredits'])
		const config = {
			...provider.config,
			internalBudgetCredits: budget
		}
		await this.repository.updateProvider(providerId, {
			config: sanitizeConfig(provider.kind, config),
			updatedAt: this.clock.now().toISOString()
		})
		await this.recordAllowed(
			identity,
			'provider.internal_budget.update',
			'provider',
			providerId
		)
		return this.provider(identity, providerId)
	}

	async refreshCredentialUsage(
		identity: AccessIdentity,
		providerId: string,
		credentialId: string
	) {
		await this.requireLevel1(identity, 'provider.credential.usage.refresh', providerId)
		await this.requireChatgptProvider(providerId)
		const credential = (await this.repository.listCredentials(providerId))
			.find(item => item.id === credentialId)
		if (!credential) throw this.notFound()
		if (!this.adapter.refreshChatgptAccountUsage) {
			throw new SafeError({
				code: 'provider_usage_refresh_unavailable',
				message: '当前 Provider 运行时不支持主动刷新额度。',
				statusCode: 409
			})
		}
		try {
			await this.adapter.refreshChatgptAccountUsage(credentialId)
			await this.recordAllowed(
				identity,
				'provider.credential.usage.refresh',
				'provider_credential',
				credentialId
			)
		} catch (error) {
			await this.audit(
				this.repository,
				identity,
				'provider.credential.usage.refresh',
				'provider_credential',
				credentialId,
				'failed'
			)
			if (
				error instanceof SafeError &&
				error.code === 'provider_relogin_required'
			) {
				throw error
			}
			throw new SafeError({
				code: 'provider_usage_refresh_failed',
				message: '上游额度刷新失败，请检查账号状态后重试。',
				statusCode: 502
			})
		}
		return this.provider(identity, providerId)
	}

  async models(identity: AccessIdentity) {
    await this.requireLevel1(identity, 'model.list', null)
    return { models: await this.repository.listModelRoutes() }
  }

  async consoleUsage(identity: AccessIdentity, days = 370) {
    await this.requireLevel1(identity, 'provider.usage.console', null)
    const boundedDays = Math.max(1, Math.min(370, Math.trunc(days) || 370))
    const since = new Date(
      this.clock.now().getTime() - boundedDays * 24 * 60 * 60 * 1000
    ).toISOString()
    const [models, records] = await Promise.all([
      this.repository.listProviderModelUsageSummaries(),
      this.repository.listConsoleUsageRecords(since)
    ])
    return { models, records, since }
  }

  async probe(identity: AccessIdentity, providerId: string) {
    await this.requireLevel1(identity, 'provider.probe', providerId)
    const provider = await this.requireProvider(providerId)
    if (provider.status !== 'active') {
      return {
        ok: false,
        latency: 0,
        source: 'provider-active-probe',
        error: 'Provider is disabled.'
      }
    }
    if (!this.adapter.probeProvider) {
      return {
        ok: false,
        latency: 0,
        source: 'provider-active-probe',
        error: 'Active upstream probing is not supported by this runtime.'
      }
    }
    const credentials = await this.repository.listCredentials(provider.id)
    const result = await this.adapter.probeProvider({
      provider: provider.kind === 'openai'
        ? 'openai-api'
        : provider.kind === 'chatgpt'
          ? 'chatgpt-sub'
          : provider.kind,
      ...(provider.kind === 'relay' ? { relayId: provider.id } : {}),
      ...(credentials[0] ? { credentialId: credentials[0].id } : {})
    })
    await this.recordAllowed(identity, 'provider.probe', 'provider', provider.id)
    return result
  }

  async putModel(
    identity: AccessIdentity,
    publicModelId: string,
    body: Record<string, unknown>
  ) {
    await this.requireLevel1(identity, 'model.update', publicModelId)
    const providerId = requiredText(body['providerId'], 'Provider ID')
    const provider = await this.requireProvider(providerId)
    const upstreamModelId = requiredText(body['upstreamModelId'], '上游模型 ID')
    const expectedPublicId = publicModelIdForValidation(provider, upstreamModelId)
    if (publicModelId !== expectedPublicId) {
      throw new SafeError({
        code: 'invalid_public_model_id',
        message: `该 Provider 的公开模型 ID 必须为 ${expectedPublicId}。`,
        statusCode: 400
      })
    }
    const existing = (await this.repository.listModelRoutes())
      .find(route => route.publicModelId === publicModelId && route.providerId === providerId)
    const now = this.clock.now().toISOString()
    const route: ModelRouteRecord = {
      id: existing?.id || this.ids.opaque('route'),
      publicModelId,
      providerId,
      upstreamModelId,
      priority: Math.max(1, Math.min(10_000, Number(body['priority']) || 100)),
      enabled: body['enabled'] !== false,
      policy: {},
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      version: existing?.version || 1
    }
    await this.repository.upsertModelRoute(route)
    await this.recordAllowed(identity, 'model.update', 'model_route', route.id)
    await this.applyRuntimeConfiguration()
    return route
  }

  async diagnostics(identity: AccessIdentity, section = 'all') {
    await this.requireLevel1(identity, 'diagnostics.read', section)
    const value = this.adapter.safeDiagnostics
      ? await this.adapter.safeDiagnostics()
      : {}
    const safe = redactValue(value) as Record<string, unknown>
    if (section === 'providers') return { providers: safe['providers'] || {} }
    if (section === 'circuits') return { circuits: safe['circuits'] || {} }
    if (section === 'recent-route-errors') {
      return { recentRouteErrors: safe['recentRouteErrors'] || [] }
    }
    return safe
  }

  async startChatgptLogin(identity: AccessIdentity, providerId: string) {
    await this.requireLevel1(identity, 'provider.chatgpt_login.start', providerId)
    await this.requireChatgptProvider(providerId)
    const result = await this.chatgptLogin.start(providerId, async authJson => {
      await this.addCredential(identity, providerId, { secret: authJson })
    })
    await this.recordAllowed(
      identity,
      'provider.chatgpt_login.start',
      'provider',
      providerId
    )
    return result
  }

  async startDefaultChatgptLogin(
    identity: AccessIdentity,
    body: Record<string, unknown>
  ) {
    await this.requireLevel1(identity, 'provider.chatgpt_account.login.start', null)
    const label = optionalText(body['label'], 80)
    if (body['routingEnabled'] !== undefined && typeof body['routingEnabled'] !== 'boolean') {
      throw new SafeError({
        code: 'invalid_request',
        message: 'routingEnabled 必须是布尔值。',
        statusCode: 400
      })
    }
    const provider = await this.ensureDefaultChatgptProvider(identity)
    this.activeChatgptLoginProviderId = provider.id
    const result = await this.chatgptLogin.start(provider.id, async authJson => {
      await this.importChatgptAccount(identity, {
        authJson,
        ...(label ? { label } : {}),
        routingEnabled: body['routingEnabled'] !== false
      })
    })
    await this.recordAllowed(
      identity,
      'provider.chatgpt_account.login.start',
      'provider',
      provider.id
    )
    return { ...result, providerId: provider.id }
  }

  async defaultChatgptLoginStatus(identity: AccessIdentity) {
    await this.requireLevel1(identity, 'provider.chatgpt_account.login.status', null)
    const providerId = this.activeChatgptLoginProviderId ||
      (await this.repository.listProviders()).find(item => item.kind === 'chatgpt')?.id
    if (!providerId) {
      return { status: 'idle' as const }
    }
    return {
      ...await this.chatgptLogin.status(providerId),
      providerId
    }
  }

  async chatgptLoginStatus(identity: AccessIdentity, providerId: string) {
    await this.requireLevel1(identity, 'provider.chatgpt_login.status', providerId)
    await this.requireChatgptProvider(providerId)
    return this.chatgptLogin.status(providerId)
  }

  private async ensureDefaultChatgptProvider(identity: AccessIdentity): Promise<ProviderRecord> {
    const providers = await this.repository.listProviders()
    const existing = providers.find(item => item.kind === 'chatgpt' && item.status === 'active') ||
      providers.find(item => item.kind === 'chatgpt')
    if (existing) return existing

    const now = this.clock.now().toISOString()
    const provider = await this.repository.inTransaction(async repository => {
      const concurrent = (await repository.listProviders())
        .find(item => item.kind === 'chatgpt')
      if (concurrent) return concurrent
      const created: ProviderRecord = {
        id: this.ids.opaque('provider'),
        kind: 'chatgpt',
        displayName: DEFAULT_CHATGPT_PROVIDER_NAME,
        status: 'active',
        config: sanitizeConfig('chatgpt', { models: DEFAULT_CHATGPT_MODELS }),
        createdAt: now,
        updatedAt: now,
        version: 1
      }
      await repository.insertProvider(created)
      for (const [index, model] of DEFAULT_CHATGPT_MODELS.entries()) {
        await repository.upsertModelRoute({
          id: this.ids.opaque('route'),
          publicModelId: model,
          providerId: created.id,
          upstreamModelId: model,
          priority: index + 1,
          enabled: true,
          policy: {},
          createdAt: now,
          updatedAt: now,
          version: 1
        })
      }
      await this.audit(
        repository,
        identity,
        'provider.create',
        'provider',
        created.id,
        'allowed',
        { automatic: true, source: 'chatgpt_account_login' }
      )
      return created
    })
    await this.applyRuntimeConfiguration()
    return provider
  }

  private async applyRuntimeConfiguration(): Promise<void> {
    if (!this.adapter.configureProviders) return
    const [providers, credentials, routes] = await Promise.all([
      this.repository.listProviders(),
      this.repository.listCredentials(),
      this.repository.listModelRoutes()
    ])
    const active = providers.filter(provider => provider.status === 'active')
    const credentialFor = (providerId: string) =>
      credentials.find(credential => credential.providerId === providerId)
    const openai = active.find(provider => provider.kind === 'openai')
    const deepseek = active.find(provider => provider.kind === 'deepseek')
    const chatgpt = active.filter(provider => provider.kind === 'chatgpt')
    const relays = active.filter(provider => provider.kind === 'relay')
    const openaiCredential = openai ? credentialFor(openai.id) : undefined
    const deepseekCredential = deepseek ? credentialFor(deepseek.id) : undefined
		const runtime: GatewayProviderRuntimeConfiguration = {
      deepseekApiKey: deepseekCredential?.secretPayload || '',
      deepseekUrl: String(deepseek?.config['baseUrl'] || DEFAULTS.deepseekUrl),
      openaiApiKey: openaiCredential?.secretPayload || '',
      openaiApiBaseUrl: String(openai?.config['baseUrl'] || DEFAULTS.openaiBaseUrl),
      chatgptResponsesUrl: String(
        chatgpt[0]?.config['baseUrl'] || DEFAULTS.chatgptResponsesUrl
      ),
			chatgptAccounts: chatgpt.flatMap(provider =>
        credentials
          .filter(credential => credential.providerId === provider.id)
          .map(credential => parseChatgptCredential(provider, credential))
          .filter((value): value is Record<string, unknown> => value !== null)
			),
			chatgptAccountStrategy: accountRoutingStrategy(
				chatgpt[0]?.config['accountRoutingStrategy']
			),
      relays: relays.flatMap(provider => {
        const credential = credentialFor(provider.id)
        if (!credential) return []
        return [{
          id: provider.id,
          name: provider.displayName,
          base_url: String(provider.config['baseUrl'] || ''),
          api_key: credential.secretPayload,
          models: provider.config['models'] as string[]
        }]
      }),
      fallbackChain: routes
        .filter(route => route.enabled)
        .map(route => {
          const provider = providers.find(item => item.id === route.providerId)
          return {
            provider: provider?.kind === 'relay'
              ? `relay:${route.providerId}`
              : provider?.kind === 'chatgpt'
                ? 'chatgpt-sub'
                : provider?.kind === 'openai'
                  ? 'openai-api'
                  : 'deepseek',
            model: route.publicModelId
          }
        }),
      modelIds: routes.filter(route => route.enabled).map(route => route.publicModelId)
    }
    await this.adapter.configureProviders(runtime)
  }

  private async requireLevel1(
    identity: AccessIdentity,
    action: string,
    targetId: string | null
  ): Promise<void> {
    const role = await this.repository.accountRole(identity.accountId)
    if (identity.role === 'level1' && role === 'level1') return
    await this.audit(
      this.repository,
      identity,
      action,
      'provider_admin',
      targetId,
      'denied'
    )
    throw new SafeError({
      code: 'forbidden',
      message: '仅一级管理员可以访问 Provider 和系统诊断。',
      statusCode: 403
    })
  }

  private async audit(
    repository: ProviderRepository,
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: 'allowed' | 'denied' | 'failed',
    safeMetadata?: Record<string, unknown>
  ): Promise<void> {
    await repository.insertAuditEvent({
      id: this.ids.opaque('audit'),
      actorAccountId: identity.accountId,
      organizationId: identity.organizationId,
      action,
      targetType,
      targetId,
      outcome,
      ...(safeMetadata ? { safeMetadata } : {}),
      createdAt: this.clock.now().toISOString()
    })
  }

  private async recordAllowed(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null
  ): Promise<void> {
    await this.audit(
      this.repository,
      identity,
      action,
      targetType,
      targetId,
      'allowed'
    )
  }

  private async requireProvider(providerId: string): Promise<ProviderRecord> {
    const provider = await this.repository.getProvider(providerId)
    if (!provider) throw this.notFound()
    return provider
  }

  private async requireChatgptProvider(providerId: string): Promise<ProviderRecord> {
    const provider = await this.requireProvider(providerId)
    if (provider.kind !== 'chatgpt') {
      throw new SafeError({
        code: 'invalid_provider_kind',
        message: 'OpenAI 官方登录只能用于 ChatGPT Provider。',
        statusCode: 409
      })
    }
    return provider
  }

  private notFound(): SafeError {
    return new SafeError({
      code: 'provider_not_found',
      message: '未找到 Provider 或凭据。',
      statusCode: 404
    })
  }
}

function publicModelIdForValidation(
  provider: ProviderRecord,
  upstreamModelId: string
): string {
  return publicModelId(provider.kind, provider.id, upstreamModelId)
}
