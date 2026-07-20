import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import formbody from '@fastify/formbody'
import type { Clock } from './common/clock.js'
import { SystemClock } from './common/clock.js'
import type { IdSource } from './common/ids.js'
import { CryptoIdSource } from './common/ids.js'
import { SafeError } from './common/errors.js'
import { HmacSha256Digest } from './common/digests.js'
import { SafeLogger } from './common/logging.js'
import type { GatewayConfig } from './config.js'
import {
  DEFAULT_REQUEST_BODY_MAX_MIB,
  DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  loadGatewayConfig
} from './config.js'
import type { DatabaseHandle } from './db/database.js'
import { createGatewayDatabase } from './db/database.js'
import {
  FixedMockAccessTokenVerifier,
  requireAccessToken,
  type AccessTokenVerifier
} from './api/middleware/authentication.js'
import { registerNoStore } from './api/middleware/no-store.js'
import { registerRequestContext } from './api/middleware/request-context.js'
import { registerSafeErrors } from './api/middleware/safe-errors.js'
import { MockStateService } from './mock/mock-state-service.js'
import { AuthRepository } from './db/repositories/auth-repository.js'
import { PasswordService } from './auth/password-service.js'
import { AuthorizationService } from './auth/authorization-service.js'
import { TokenService } from './auth/token-service.js'
import { AccountService } from './auth/account-service.js'
import { BootstrapService } from './auth/bootstrap-service.js'
import { registerAuthRoutes } from './api/auth-routes.js'
import { registerAccountSecurityRoutes } from './api/account-security-routes.js'
import { loadGatewaySecrets, type GatewaySecrets } from './security/gateway-secrets.js'
import {
  StandaloneRouteAdapter,
  type ProviderRouteAdapter
} from './routing/standalone-route-adapter.js'
import { ModelCatalog } from './routing/model-catalog.js'
import { RequestPreflight } from './routing/request-preflight.js'
import { ResponsesGateway } from './routing/responses-gateway.js'
import { registerV1Routes } from './api/v1-routes.js'
import { WebviewSessionRepository } from './db/repositories/webview-session-repository.js'
import { WebviewSessionService } from './auth/webview-session-service.js'
import {
  managementSessionAuthenticator,
  registerWebviewRoutes
} from './api/webview-routes.js'
import { registerManagementShell } from './api/management-shell.js'
import { ProviderRepository } from './db/repositories/provider-repository.js'
import { ProviderService } from './providers/provider-service.js'
import { registerAdminProviderRoutes } from './api/admin-provider-routes.js'
import { registerAdminOrganizationRoutes } from './api/admin-organization-routes.js'
import { registerAdminCreditRoutes } from './api/admin-credit-routes.js'
import { OrganizationRepository } from './db/repositories/organization-repository.js'
import { OrganizationService } from './organizations/organization-service.js'
import { CreditRepository } from './db/repositories/credit-repository.js'
import { CreditService } from './credits/credit-service.js'
import { RateService } from './credits/rate-service.js'
import { RiskEstimator } from './credits/risk-estimator.js'
import { TurnRiskService } from './credits/turn-risk-service.js'
import { SettlementService } from './credits/settlement-service.js'
import {
  ProcessChatgptLoginService,
  type ChatgptLoginCoordinator
} from './providers/chatgpt-login-service.js'
import { AuditRepository } from './db/repositories/audit-repository.js'
import { AuditService } from './audit/audit-service.js'
import { RetentionService } from './audit/retention-service.js'
import { registerAuditRoutes } from './api/audit-routes.js'
import { ProviderWorkerClient } from './provider-worker/provider-worker-client.js'
import {
  ProviderWorkerSettlementReconciler
} from './provider-worker/settlement-reconciler.js'
import {
  loadCredentialKeyProvider
} from './security/credential-keys.js'
import {
  EnvelopeCredentialProtector,
  type CredentialProtector
} from './security/envelope-credential-protector.js'

export interface GatewayApp {
  readonly app: FastifyInstance
  readonly config: GatewayConfig
  readonly database: DatabaseHandle
  readonly mock: MockStateService | null
  close(): Promise<void>
}

export async function createGatewayApp(options: {
  config?: GatewayConfig
  clock?: Clock
  ids?: IdSource
  logger?: SafeLogger
  database?: DatabaseHandle
  tokenVerifier?: AccessTokenVerifier
  secrets?: GatewaySecrets
  bootstrapSink?: (loginName: string, temporaryPassword: string) => void
  providerAdapter?: ProviderRouteAdapter
  chatgptLogin?: ChatgptLoginCoordinator
  credentialProtector?: CredentialProtector
} = {}): Promise<GatewayApp> {
  const config = options.config || loadGatewayConfig()
  const clock = options.clock || new SystemClock()
  const ids = options.ids || new CryptoIdSource()
  const logger = options.logger || new SafeLogger({ clock })
  const database = options.database || createGatewayDatabase(config)
  const mock = config.authMode === 'mock'
    ? new MockStateService({ state: config.mockState, clock, ids })
    : null
  fs.mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 })
  await database.migrateToLatest()

  const app = Fastify({
    logger: false,
    genReqId: () => ids.opaque('req'),
    bodyLimit: config.requestBody?.maxBytes ??
      DEFAULT_REQUEST_BODY_MAX_MIB * 1024 * 1024,
    trustProxy: false,
    requestTimeout: config.requestBody?.timeoutMs ??
      DEFAULT_REQUEST_BODY_TIMEOUT_MS
  })
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
  await app.register(formbody)
  registerRequestContext(app, ids)
  registerNoStore(app)
  registerSafeErrors(app, logger)

  app.get('/live', async () => ({
    status: 'ok',
    service: 'ai-editor-gateway',
    mode: 'gateway'
  }))

  app.get('/ready', async () => ({
    status: 'ready',
    service: 'ai-editor-gateway'
  }))

  registerManagementShell(app)
  let chatgptLogin: ChatgptLoginCoordinator | null = null
  let retentionTimer: ReturnType<typeof setInterval> | null = null
  let providerWorkerReconciler: ProviderWorkerSettlementReconciler | null = null

  if (config.authMode === 'mock' && mock) {
    const tokenVerifier = options.tokenVerifier || new FixedMockAccessTokenVerifier()
    const authenticate = requireAccessToken(tokenVerifier)
    app.get('/api/v1/account/status', { preHandler: authenticate }, async () => mock.status())
    app.post('/api/v1/account/status/retry', { preHandler: authenticate }, async () => mock.status())
    app.post('/api/v1/account/webview-ticket', { preHandler: authenticate }, async request => {
      const body = request.body as { audience?: string; purpose?: string } | undefined
      if (body?.audience !== `http://${config.host}:${config.port}` || body.purpose !== 'account-management') {
        throw new SafeError({
          code: 'invalid_webview_audience',
          message: '管理页面目标地址无效。',
          statusCode: 400
        })
      }
      return { ticket: ids.secret(32), expiresIn: 60 }
    })
    app.post('/api/v1/account/logout', { preHandler: authenticate }, async (_request, reply) => {
      await reply.status(204).send()
    })
    app.get('/v1/models', { preHandler: authenticate }, async () => mock.models())
  } else {
    const secrets = options.secrets || loadGatewaySecrets(config)
    const digest = new HmacSha256Digest(Buffer.from(secrets.digestKey))
    const repository = new AuthRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const webviewRepository = new WebviewSessionRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const passwords = new PasswordService()
    const tokens = new TokenService(
      repository,
      digest,
      secrets.accessTokenKey,
      clock,
      ids
    )
    const verifier: AccessTokenVerifier = options.tokenVerifier || {
      verify: token => tokens.verifyAccessToken(token)
    }
    const v1Verifier: AccessTokenVerifier = options.tokenVerifier || {
      verify: token => tokens.authenticateAccessToken(token)
    }
    const statusVerifier: AccessTokenVerifier = options.tokenVerifier || {
      verify: token => tokens.authenticateAccessToken(token, {
        allowPasswordChange: true,
        allowInactive: true
      })
    }
    const publicOrigin = config.publicOrigin || `http://${config.host}:${config.port}`
    const webviews = new WebviewSessionService(
      webviewRepository,
      digest,
      clock,
      ids,
      publicOrigin,
      config.environment === 'preview' || config.environment === 'production'
    )
    const authenticateBearer = requireAccessToken(verifier)
    const authenticateManagement = managementSessionAuthenticator(webviews)
    const authenticateAccount = async (
      request: Parameters<typeof authenticateBearer>[0],
      reply: Parameters<typeof authenticateBearer>[1]
    ) => {
      if (request.headers.authorization) {
        await authenticateBearer(request, reply)
        return
      }
      await authenticateManagement(request)
    }
    const authorization = new AuthorizationService(
      repository,
      passwords,
      digest,
      clock,
      ids
    )
    const providerAdapter = options.providerAdapter ||
      (config.providerWorker
        ? new ProviderWorkerClient(config.providerWorker)
        : new StandaloneRouteAdapter({ storageRoot: config.dataRoot }))
    if (providerAdapter instanceof StandaloneRouteAdapter) await providerAdapter.initialize()
    const credentialProtector = options.credentialProtector ||
      new EnvelopeCredentialProtector(loadCredentialKeyProvider(config))
    const providerRepository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      credentialProtector
    )
    const organizationRepository = new OrganizationRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const organizations = new OrganizationService(organizationRepository, digest, clock, ids)
    const auditRepository = new AuditRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const audit = new AuditService(auditRepository, clock, ids)
    const retention = new RetentionService(auditRepository, clock)
    await retention.cleanupExpiredBodies()
    retentionTimer = setInterval(() => {
      void retention.cleanupExpiredBodies().catch(error => {
        logger.error('audit_retention_cleanup_failed', { error })
      })
    }, 60 * 60_000)
    retentionTimer.unref()
    const creditRepository = new CreditRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const credits = new CreditService(creditRepository, clock, ids)
    const rates = new RateService(creditRepository, clock, ids)
    const risks = new TurnRiskService(
      creditRepository,
      credits,
      new RiskEstimator(rates),
      clock
    )
    const settlements = new SettlementService(creditRepository, rates, clock, ids)
    const accounts = new AccountService(repository, passwords, tokens, clock, credits)
    chatgptLogin = options.chatgptLogin ||
      new ProcessChatgptLoginService(config.dataRoot, ids, () => clock.now())
    const providerService = new ProviderService(
      providerRepository,
      providerAdapter,
      config,
      clock,
      ids,
      chatgptLogin
    )
    await providerService.initialize()
    const models = new ModelCatalog(providerAdapter)
    const responses = new ResponsesGateway(
      new RequestPreflight(tokens, models),
      providerAdapter,
      risks,
      settlements,
      audit,
      logger
    )
    if (providerAdapter instanceof ProviderWorkerClient) {
      providerWorkerReconciler = new ProviderWorkerSettlementReconciler(
        providerAdapter,
        settlements,
        logger
      )
      providerWorkerReconciler.start()
    }
    if (!options.bootstrapSink && await repository.countAccounts() === 0) {
      throw new Error(
        'Gateway bootstrap is required; run gateway/src/bootstrap-cli.ts in the foreground first'
      )
    }
    const bootstrap = await new BootstrapService(
      repository,
      passwords,
      clock,
      ids
    ).initialize()
    if (bootstrap.created && bootstrap.loginName && bootstrap.temporaryPassword) {
      options.bootstrapSink?.(bootstrap.loginName, bootstrap.temporaryPassword)
    }
    registerAuthRoutes(app, {
      authorization,
      tokens,
      accounts,
      verifier,
      statusVerifier,
      accountAuthenticator: authenticateAccount,
      currentModel: () => models.currentModel(),
      issueWebviewTicket: (identity, body) => webviews.issueTicket(identity, body)
    })
    registerAccountSecurityRoutes(app, {
      authenticate: authenticateAccount,
      accounts
    })
    registerWebviewRoutes(app, webviews)
    registerAdminProviderRoutes(app, {
      authenticate: authenticateAccount,
      service: providerService,
      rates
    })
    registerAdminOrganizationRoutes(app, {
      authenticate: authenticateAccount,
      service: organizations
    })
    registerAdminCreditRoutes(app, {
      authenticate: authenticateAccount,
      credits,
      rates
    })
    registerAuditRoutes(app, {
      authenticate: authenticateAccount,
      audit,
      retention
    })
    registerV1Routes(app, { verifier: v1Verifier, models, responses })
  }

  return {
    app,
    config,
    database,
    mock,
    async close() {
      if (retentionTimer) clearInterval(retentionTimer)
      await providerWorkerReconciler?.stop()
      await chatgptLogin?.close()
      await app.close()
      await database.close()
    }
  }
}
