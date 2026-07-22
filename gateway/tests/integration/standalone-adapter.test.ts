import http from 'node:http'
import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('existing Provider compatibility adapter (T044-T046)', () => {
  let upstream: http.Server
  let fixture: RealGatewayFixture
  let observedUrl: string | undefined
  let observedAuthorization: string | undefined
  let observedBody: { model?: string; stream?: boolean } | undefined
  let upstreamBaseUrl: string
  const previous: Record<string, string | undefined> = {}

  beforeEach(async () => {
    observedUrl = undefined
    observedAuthorization = undefined
    observedBody = undefined
    upstream = http.createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        observedUrl = request.url
        observedAuthorization = request.headers.authorization
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-5.4-mini', object: 'model', owned_by: 'test' }]
        }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observedUrl = request.url
      observedAuthorization = request.headers.authorization
      observedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string
        stream?: boolean
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-isolated',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-isolated',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.4-mini',
        choices: [{
          index: 0,
          delta: { content: 'isolated-real-chain' },
          finish_reason: null
        }]
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-isolated',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', resolve)
    })
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Local upstream address is invalid')
    upstreamBaseUrl = `http://127.0.0.1:${address.port}/v1`
    for (const key of [
      'CODEX_RELAYS',
      'CODEX_PROXY_STORAGE_ROOT',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'CODEX_OPENAI_API_UPSTREAM',
      'CODEX_OPENAI_API_BASE_URL',
      'CODEX_CHATGPT_RESPONSES_URL'
    ]) {
      previous[key] = process.env[key]
      delete process.env[key]
    }
    process.env.CODEX_RELAYS = JSON.stringify([{
      id: 'isolated',
      name: 'Isolated test Provider',
      base_url: upstreamBaseUrl,
      api_key: 'isolated-local-test-key',
      models: ['gpt-5.4-mini']
    }])
    fixture = await createRealGatewayFixture({ useDefaultProviderAdapter: true })
  })

  afterEach(async () => {
    await fixture.gateway.close()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('streams a non-Mock model through the existing OpenAI Provider modules', async () => {
    const initial = await loginBootstrapAndExchange(fixture)
    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${initial.accessToken}` },
      payload: {
        currentPassword: fixture.bootstrap.password,
        newPassword: 'PermanentPassword123',
        email: 'admin@example.com'
      }
    })
    const tokens = changed.json()
    const models = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    })
    expect(models.statusCode).toBe(200)
    expect(models.body).not.toContain('gpt-mock')
    expect(models.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'relay-isolated-gpt-5.4-mini' })
    ]))
    expect(models.json().data.map((model: { id: string }) => model.id)).not.toEqual(
      expect.arrayContaining([
        'openai-api-gpt-5.4-mini',
        'gpt-5.4-mini',
        'deepseek-v4-pro'
      ])
    )

    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'x-ai-editor-device-session': tokens.deviceSessionId,
        'x-ai-editor-turn-id': 'turn_real_adapter_1234'
      },
      payload: {
        model: 'relay-isolated-gpt-5.4-mini',
        input: 'hello',
        stream: true
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toContain('isolated-real-chain')
    expect(response.body).toContain('response.completed')
    expect(observedUrl).toBe('/v1/chat/completions')
    expect(observedAuthorization).toBe('Bearer isolated-local-test-key')
    expect(observedBody).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true
    })

    const centralRelay = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: {
        kind: 'relay',
        displayName: 'Active Probe Relay',
        config: {
          baseUrl: upstreamBaseUrl,
          models: ['gpt-5.4-mini']
        }
      }
    })
    const centralRelayId = centralRelay.json().id as string
    await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${centralRelayId}/credentials`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { secret: 'isolated-local-test-key' }
    })
    const probe = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/ping',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { type: 'relay', relayId: centralRelayId }
    })
    expect(probe.statusCode).toBe(200)
    expect(probe.json()).toMatchObject({
      ok: true,
      status: 200,
      source: 'standalone-active-probe'
    })
    expect(observedUrl).toBe('/v1/models')
    expect(observedAuthorization).toBe('Bearer isolated-local-test-key')

    const importedSubscription = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/import',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: {
        authJson: JSON.stringify({
          tokens: {
            access_token: 'isolated-subscription-access-token',
            refresh_token: 'isolated-subscription-refresh-token',
            account_id: 'isolated-subscription-account'
          }
        }),
        label: 'Isolated subscription account',
        routingEnabled: true
      }
    })
    expect(importedSubscription.statusCode).toBe(200)

    const modelsAfterSubscription = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    })
    expect(modelsAfterSubscription.statusCode).toBe(200)
    expect(modelsAfterSubscription.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-5.6-sol' }),
      expect.objectContaining({ id: 'gpt-5.6-terra' }),
      expect.objectContaining({ id: 'gpt-5.6-luna' })
    ]))
  })
})
