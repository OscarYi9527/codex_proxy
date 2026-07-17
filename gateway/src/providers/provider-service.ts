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
  type ProviderRecord
} from '../db/repositories/provider-repository.js'
import type { AccessIdentity } from '../auth/types.js'
import type {
  GatewayProviderRuntimeConfiguration,
  ProviderRouteAdapter
} from '../routing/standalone-route-adapter.js'
import {
  assertCredentialStorageAllowed,
  PLAINTEXT_STORAGE_WARNING,
  requireDevelopmentPlaintext
} from './credential-policy.js'
import type { ChatgptLoginCoordinator } from './chatgpt-login-service.js'

const DEFAULTS = {
  deepseekUrl: 'https://api.deepseek.com/anthropic/v1/messages',
  openaiBaseUrl: 'https://api.openai.com/v1',
  chatgptResponsesUrl: 'https://chatgpt.com/backend-api/codex/responses'
}

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
    models
  }
}

function maskSecret(secret: string): string {
  const suffix = secret.slice(-4)
  const prefix = /^[A-Za-z0-9_-]{2,4}/.exec(secret)?.[0].slice(0, 3) || '***'
  return `${prefix}...${suffix}`
}

function safeCredential(record: ProviderCredentialRecord) {
  return {
    id: record.id,
    maskedPreview: maskSecret(record.secretPayload),
    storageFormat: record.storageKind,
    updatedAt: record.updatedAt,
    lastUsedAt: null
  }
}

function safeProvider(
  provider: ProviderRecord,
  credentials: readonly ProviderCredentialRecord[]
) {
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
      .map(safeCredential),
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
    return {
      id: String(source['account_id'] || source['accountId'] || credential.id),
      label: provider.displayName,
      access_token: accessToken || '',
      refresh_token: refreshToken || '',
      expires_at: source['expires_at'] || source['expiresAt'] || null,
      routing_enabled: true,
      status: 'active'
    }
  } catch {
    return null
  }
}

export class ProviderService {
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

  async list(identity: AccessIdentity) {
    await this.requireLevel1(identity, 'provider.list', null)
    const [providers, credentials] = await Promise.all([
      this.repository.listProviders(),
      this.repository.listCredentials()
    ])
    return {
      warning: credentials.some(item => item.storageKind === 'plaintext-v1')
        ? PLAINTEXT_STORAGE_WARNING
        : null,
      providers: providers.map(provider => safeProvider(provider, credentials))
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
        : { config: sanitizeConfig(current.kind, body['config']) }),
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
    return safeProvider(provider, await this.repository.listCredentials(providerId))
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
    requireDevelopmentPlaintext(this.config)
    await this.requireProvider(providerId)
    const secret = requiredText(body['secret'], 'Provider 凭据', 10_000)
    const now = this.clock.now().toISOString()
    const credential: ProviderCredentialRecord = {
      id: this.ids.opaque('cred'),
      providerId,
      storageKind: 'plaintext-v1',
      secretPayload: secret,
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
    return {
      ...safeCredential(credential),
      warning: PLAINTEXT_STORAGE_WARNING
    }
  }

  async removeCredential(
    identity: AccessIdentity,
    providerId: string,
    credentialId: string
  ): Promise<void> {
    await this.requireLevel1(identity, 'provider.credential.delete', providerId)
    if (!await this.repository.deleteCredential(providerId, credentialId)) {
      throw this.notFound()
    }
    await this.recordAllowed(
      identity,
      'provider.credential.delete',
      'provider_credential',
      credentialId
    )
    await this.applyRuntimeConfiguration()
  }

  async models(identity: AccessIdentity) {
    await this.requireLevel1(identity, 'model.list', null)
    return { models: await this.repository.listModelRoutes() }
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

  async chatgptLoginStatus(identity: AccessIdentity, providerId: string) {
    await this.requireLevel1(identity, 'provider.chatgpt_login.status', providerId)
    await this.requireChatgptProvider(providerId)
    return this.chatgptLogin.status(providerId)
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
    outcome: 'allowed' | 'denied' | 'failed'
  ): Promise<void> {
    await repository.insertAuditEvent({
      id: this.ids.opaque('audit'),
      actorAccountId: identity.accountId,
      organizationId: identity.organizationId,
      action,
      targetType,
      targetId,
      outcome,
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
