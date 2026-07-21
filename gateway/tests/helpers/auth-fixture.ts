import { createHash } from 'node:crypto'
import type { Clock } from '../../src/common/clock.js'
import { SequenceIdSource } from '../../src/common/ids.js'
import { SafeLogger } from '../../src/common/logging.js'
import type { GatewayConfig } from '../../src/config.js'
import { createGatewayApp, type GatewayApp } from '../../src/app.js'
import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import type { ProviderRouteAdapter } from '../../src/routing/standalone-route-adapter.js'
import type { ChatgptLoginCoordinator } from '../../src/providers/chatgpt-login-service.js'
import type {
  ProviderCredentialKeyring
} from '../../src/security/provider-master-key.js'

export class MutableClock implements Clock {
  #nowMs: number

  constructor(value = '2026-07-17T00:00:00.000Z') {
    this.#nowMs = Date.parse(value)
  }

  now(): Date {
    return new Date(this.#nowMs)
  }

  nowMs(): number {
    return this.#nowMs
  }

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds
  }
}

export interface RealGatewayFixture {
  readonly gateway: GatewayApp
  readonly database: DatabaseHandle
  readonly clock: MutableClock
  readonly bootstrap: {
    loginName: string
    password: string
  }
}

export async function createRealGatewayFixture(
  options: {
    providerAdapter?: ProviderRouteAdapter
    useDefaultProviderAdapter?: boolean
    chatgptLogin?: ChatgptLoginCoordinator
    providerCredentialKeyring?: ProviderCredentialKeyring
    prepareDatabase?: (database: DatabaseHandle) => Promise<void>
  } = {}
): Promise<RealGatewayFixture> {
  const config: GatewayConfig = {
    environment: 'test',
    host: '127.0.0.1',
    port: 47920,
    dataRoot: '.ai-editor-dev/real-auth-test',
    database: {
      dialect: 'sqlite',
      sqliteFile: ':memory:'
    },
    authMode: 'real',
    mockState: 'login_required'
  }
  const database = databaseHandle(createSqliteDatabase(':memory:'))
  if (options.prepareDatabase) {
    await database.migrateToLatest()
    await options.prepareDatabase(database)
  }
  const clock = new MutableClock()
  let bootstrap: RealGatewayFixture['bootstrap'] | undefined
  const defaultTestAdapter = {
    async listModels() {
      return {
        object: 'list' as const,
        data: [{ id: 'real-test-model', object: 'model' as const, owned_by: 'test' }]
      }
    },
    async forwardResponses() {
      throw new Error('Not used by authentication fixture')
    }
  } satisfies ProviderRouteAdapter
  let gateway: GatewayApp
  try {
    gateway = await createGatewayApp({
      config,
      database,
      clock,
      ids: new SequenceIdSource(),
      logger: new SafeLogger({ sink: () => undefined, clock }),
      secrets: {
        accessTokenKey: new Uint8Array(32).fill(7),
        digestKey: new Uint8Array(32).fill(9)
      },
      bootstrapSink: (loginName, password) => {
        bootstrap = { loginName, password }
      },
      ...(options.chatgptLogin ? { chatgptLogin: options.chatgptLogin } : {}),
      ...(options.providerCredentialKeyring
        ? { providerCredentialKeyring: options.providerCredentialKeyring }
        : {}),
      ...(options.useDefaultProviderAdapter
        ? {}
        : { providerAdapter: options.providerAdapter || defaultTestAdapter })
    })
  } catch (error) {
    await database.close()
    throw error
  }
  if (!bootstrap) {
    await gateway.close()
    throw new Error('Expected bootstrap account')
  }
  return { gateway, database, clock, bootstrap }
}

export function createPkce() {
  const verifier = 'v'.repeat(64)
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

export async function beginAuthorization(
  fixture: RealGatewayFixture,
  options: {
    state?: string
    redirectUri?: string
  } = {}
): Promise<{ transactionId: string; state: string; redirectUri: string }> {
  const state = options.state || 'state-0123456789abcdef'
  const redirectUri = options.redirectUri || 'http://127.0.0.1:54321/callback'
  const { challenge } = createPkce()
  const query = new URLSearchParams({
    client_id: 'ai-editor-code',
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  })
  const response = await fixture.gateway.app.inject({
    method: 'GET',
    url: `/api/v1/oauth/authorize?${query}`
  })
  if (response.statusCode !== 200) throw new Error(response.body)
  const match = /name="authorizationTransactionId" value="([^"]+)"/.exec(response.body)
  if (!match?.[1]) throw new Error('Authorization transaction ID is missing')
  return { transactionId: match[1], state, redirectUri }
}

export async function loginBootstrapAndExchange(
  fixture: RealGatewayFixture
): Promise<{
  accessToken: string
  refreshToken: string
  deviceSessionId: string
  accessTokenExpiresIn: number
}> {
  const authorization = await beginAuthorization(fixture)
  const login = await fixture.gateway.app.inject({
    method: 'POST',
    url: '/api/v1/oauth/authorize/login',
    payload: {
      authorizationTransactionId: authorization.transactionId,
      identifier: fixture.bootstrap.loginName,
      password: fixture.bootstrap.password
    }
  })
  if (login.statusCode !== 303) throw new Error(login.body)
  const redirect = new URL(login.headers.location as string)
  const code = redirect.searchParams.get('code')
  if (!code) throw new Error('Authorization code is missing')
  const { verifier } = createPkce()
  const exchange = await fixture.gateway.app.inject({
    method: 'POST',
    url: '/api/v1/oauth/token',
    payload: {
      grantType: 'authorization_code',
      clientId: 'ai-editor-code',
      code,
      codeVerifier: verifier,
      redirectUri: authorization.redirectUri,
      device: { name: 'Test Windows PC', platform: 'windows' }
    }
  })
  if (exchange.statusCode !== 200) throw new Error(exchange.body)
  return exchange.json()
}
