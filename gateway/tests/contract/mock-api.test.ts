import { FixedClock } from '../../src/common/clock.js'
import { SequenceIdSource } from '../../src/common/ids.js'
import { SafeLogger } from '../../src/common/logging.js'
import type { GatewayConfig } from '../../src/config.js'
import { createGatewayApp, type GatewayApp } from '../../src/app.js'
import { databaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'

const config: GatewayConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 47920,
  dataRoot: '.ai-editor-dev/gateway-api-test',
  database: {
    dialect: 'sqlite',
    sqliteFile: ':memory:'
  },
  mockState: 'ready'
}

describe('Gateway safe Mock API contract', () => {
  let gateway: GatewayApp

  beforeEach(async () => {
    gateway = await createGatewayApp({
      config,
      clock: new FixedClock('2026-07-16T00:00:00.000Z'),
      ids: new SequenceIdSource(),
      logger: new SafeLogger({ sink: () => undefined }),
      database: databaseHandle(createSqliteDatabase(':memory:'))
    })
  })

  afterEach(async () => {
    await gateway.close()
  })

  it('exposes liveness without authentication', async () => {
    const response = await gateway.app.inject({ method: 'GET', url: '/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ok', mode: 'gateway' })
  })

  it('fails closed with stable safe errors when login is missing', async () => {
    const response = await gateway.app.inject({ method: 'GET', url: '/v1/models' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: {
        code: 'login_required',
        message: '需要登录 AI Editor 产品账号。',
        requestId: expect.stringMatching(/^req_/),
        retryable: false
      }
    })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('returns safe status and account-filtered mock models', async () => {
    const headers = { authorization: 'Bearer mock-access-token' }
    const status = await gateway.app.inject({ method: 'GET', url: '/api/v1/account/status', headers })
    expect(status.json()).toEqual({
      state: 'ready',
      checkedAt: '2026-07-16T00:00:00.000Z',
      account: { display: 'mock-user@example.com', role: 'user' },
      currentModel: 'gpt-mock',
      availableCredits: '1000.000000',
      actions: []
    })
    const models = await gateway.app.inject({ method: 'GET', url: '/v1/models', headers })
    expect(models.json()).toEqual({
      object: 'list',
      data: [{ id: 'gpt-mock', object: 'model', owned_by: 'ai-editor' }]
    })
    expect(models.body).not.toMatch(/provider|credential|circuit|cost/i)
  })

  it('issues one-minute safe Webview tickets only for the fixed audience', async () => {
    const headers = { authorization: 'Bearer mock-access-token' }
    const rejected = await gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/webview-ticket',
      headers,
      payload: { audience: 'https://evil.example', purpose: 'account-management' }
    })
    expect(rejected.statusCode).toBe(400)
    const accepted = await gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/webview-ticket',
      headers,
      payload: { audience: 'http://127.0.0.1:47920', purpose: 'account-management' }
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ expiresIn: 60 })
  })
})
