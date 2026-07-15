import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import type { Clock } from './common/clock.js'
import { SystemClock } from './common/clock.js'
import type { IdSource } from './common/ids.js'
import { CryptoIdSource } from './common/ids.js'
import { SafeError } from './common/errors.js'
import { SafeLogger } from './common/logging.js'
import type { GatewayConfig } from './config.js'
import { loadGatewayConfig } from './config.js'
import type { DatabaseHandle } from './db/database.js'
import { createGatewayDatabase } from './db/database.js'
import {
  FixedMockAccessTokenVerifier,
  requireAccessToken,
  type MockAccessTokenVerifier
} from './api/middleware/authentication.js'
import { registerNoStore } from './api/middleware/no-store.js'
import { registerRequestContext } from './api/middleware/request-context.js'
import { registerSafeErrors } from './api/middleware/safe-errors.js'
import { MockStateService } from './mock/mock-state-service.js'

export interface GatewayApp {
  readonly app: FastifyInstance
  readonly config: GatewayConfig
  readonly database: DatabaseHandle
  readonly mock: MockStateService
  close(): Promise<void>
}

export async function createGatewayApp(options: {
  config?: GatewayConfig
  clock?: Clock
  ids?: IdSource
  logger?: SafeLogger
  database?: DatabaseHandle
  tokenVerifier?: MockAccessTokenVerifier
} = {}): Promise<GatewayApp> {
  const config = options.config || loadGatewayConfig()
  const clock = options.clock || new SystemClock()
  const ids = options.ids || new CryptoIdSource()
  const logger = options.logger || new SafeLogger({ clock })
  const database = options.database || createGatewayDatabase(config)
  if (config.environment === 'production' && !options.tokenVerifier) {
    await database.close()
    throw new Error('Production Gateway requires a real access-token verifier; Mock auth is disabled')
  }
  const tokenVerifier = options.tokenVerifier || new FixedMockAccessTokenVerifier()
  const mock = new MockStateService({ state: config.mockState, clock, ids })
  fs.mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 })
  await database.migrateToLatest()

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
  registerRequestContext(app, ids)
  registerNoStore(app)
  registerSafeErrors(app, logger)

  const authenticate = requireAccessToken(tokenVerifier)

  app.get('/live', async () => ({
    status: 'ok',
    service: 'ai-editor-gateway',
    mode: 'gateway'
  }))

  app.get('/ready', async () => ({
    status: 'ready',
    service: 'ai-editor-gateway'
  }))

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

  return {
    app,
    config,
    database,
    mock,
    async close() {
      await app.close()
      await database.close()
    }
  }
}
