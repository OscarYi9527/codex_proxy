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
import { loadGatewayConfig } from './config.js'
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
import { registerAccountUsageRoutes } from './api/account-usage-routes.js'
import { registerManagementShell } from './api/management-shell.js'
import { ProviderRepository } from './db/repositories/provider-repository.js'
import { ProviderService } from './providers/provider-service.js'
import { registerAdminProviderRoutes } from './api/admin-provider-routes.js'
import {
  ProcessChatgptLoginService,
  type ChatgptLoginCoordinator
} from './providers/chatgpt-login-service.js'
import {
  loadProviderCredentialKeyring,
  type ProviderCredentialKeyring
} from './security/provider-master-key.js'
import { ProviderCredentialVault } from './security/provider-credential-vault.js'
import { registerResponseSecretGuard } from './security/response-secret-guard.js'
import {
  assertGatewayDatabaseSecretsSafe
} from './security/database-secret-scan.js'

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
  providerCredentialKeyring?: ProviderCredentialKeyring
} = {}): Promise<GatewayApp> {
  const config = options.config || loadGatewayConfig()
  const clock = options.clock || new SystemClock()
  const ids = options.ids || new CryptoIdSource()
  const logger = options.logger || new SafeLogger({ clock })
  const mock = config.authMode === 'mock'
    ? new MockStateService({ state: config.mockState, clock, ids })
    : null
  fs.mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 })
  const providerCredentialKeyring = config.authMode === 'real'
    ? options.providerCredentialKeyring || loadProviderCredentialKeyring(config)
    : null
  const database = options.database || createGatewayDatabase(config)
  await database.migrateToLatest()
  if (config.environment === 'production') {
    await assertGatewayDatabaseSecretsSafe(database.db)
  }

  const app = Fastify({
    logger: false,
    genReqId: () => ids.opaque('req'),
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: false,
    requestTimeout: 30_000
  })
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
  await app.register(formbody)
  registerRequestContext(app, ids)
  registerNoStore(app)
  registerSafeErrors(app, logger)
  registerResponseSecretGuard(app)

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
      config.environment === 'production'
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
    const accounts = new AccountService(repository, passwords, tokens, clock)
    const providerAdapter = options.providerAdapter || new StandaloneRouteAdapter({
      storageRoot: config.dataRoot
    })
    if (providerAdapter instanceof StandaloneRouteAdapter) await providerAdapter.initialize()
    const providerRepository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const providerCredentialVault = new ProviderCredentialVault(
      providerCredentialKeyring as ProviderCredentialKeyring
    )
    chatgptLogin = options.chatgptLogin ||
      new ProcessChatgptLoginService(config.dataRoot, ids, () => clock.now())
    const providerService = new ProviderService(
      providerRepository,
      providerAdapter,
      config,
      clock,
      ids,
      chatgptLogin,
      providerCredentialVault
    )
    await providerService.initialize()
    const models = new ModelCatalog(providerAdapter)
    const responses = new ResponsesGateway(
      new RequestPreflight(tokens, models),
      providerAdapter
    )
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
    registerWebviewRoutes(app, webviews)
    registerAccountUsageRoutes(app, {
      authenticate: authenticateAccount,
      repository: webviewRepository
    })
    registerAdminProviderRoutes(app, {
      authenticate: authenticateAccount,
      service: providerService
    })
    registerV1Routes(app, { verifier: v1Verifier, models, responses })
  }

  return {
    app,
    config,
    database,
    mock,
    async close() {
      await chatgptLogin?.close()
      await app.close()
      await database.close()
    }
  }
}
