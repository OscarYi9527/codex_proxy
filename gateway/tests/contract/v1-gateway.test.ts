import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('Gateway authenticated model and Responses contract (T039/T043-T046)', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  let deviceSessionId: string

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
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
    expect(changed.statusCode).toBe(200)
    accessToken = changed.json().accessToken
    deviceSessionId = changed.json().deviceSessionId
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('returns authenticated non-Mock models without Provider internals', async () => {
    const response = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      object: 'list',
      data: [{ id: 'real-test-model', object: 'model', owned_by: 'ai-editor' }]
    })
    expect(response.body).not.toMatch(/gpt-mock|credential|circuit|cost|route/i)
  })

  it('blocks the model catalog until the bootstrap password and email are replaced', async () => {
    const bootstrapFixture = await createRealGatewayFixture()
    try {
      const initial = await loginBootstrapAndExchange(bootstrapFixture)
      const response = await bootstrapFixture.gateway.app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${initial.accessToken}` }
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('password_change_required')
    } finally {
      await bootstrapFixture.gateway.close()
    }
  })

  it('requires product identity, matching device session, Turn ID and enabled model', async () => {
    const missing = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(missing.statusCode).toBe(401)
    expect(missing.json().error.code).toBe('login_required')

    const wrongSession = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-ai-editor-device-session': 'ds_wrong',
        'x-ai-editor-turn-id': 'turn_contract_1234'
      },
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(wrongSession.statusCode).toBe(401)

    const missingTurn = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-ai-editor-device-session': deviceSessionId
      },
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(missingTurn.statusCode).toBe(400)
    expect(missingTurn.json().error.code).toBe('invalid_turn_id')

    const unavailable = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-ai-editor-device-session': deviceSessionId,
        'x-ai-editor-turn-id': 'turn_contract_1234'
      },
      payload: { model: 'gpt-mock', input: 'hello' }
    })
    expect(unavailable.statusCode).toBe(409)
    expect(unavailable.json().error.code).toBe('provider_unavailable')
  })
})

describe('Gateway Responses stream compatibility', () => {
  it('passes a validated request to the Provider adapter and preserves SSE', async () => {
    let forwardedModel: string | undefined
    const fixture = await createRealGatewayFixture({
      providerAdapter: {
        async listModels() {
          return {
            object: 'list',
            data: [{ id: 'real-stream-model', object: 'model', owned_by: 'test' }]
          }
        },
        async forwardResponses(_request, reply, body) {
          forwardedModel = body.model as string
          await reply
            .status(200)
            .header('content-type', 'text/event-stream')
            .send('event: response.completed\ndata: {"type":"response.completed"}\n\n')
        }
      }
    })
    try {
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
      const response = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'x-ai-editor-device-session': tokens.deviceSessionId,
          'x-ai-editor-turn-id': 'turn_stream_123456'
        },
        payload: { model: 'real-stream-model', input: 'hello', stream: true }
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('response.completed')
      expect(forwardedModel).toBe('real-stream-model')
    } finally {
      await fixture.gateway.close()
    }
  })

  it('forwards Chat Completions where the Provider adapter supports it', async () => {
    let forwarded = false
    const fixture = await createRealGatewayFixture({
      providerAdapter: {
        async listModels() {
          return {
            object: 'list',
            data: [{ id: 'real-chat-model', object: 'model', owned_by: 'test' }]
          }
        },
        async forwardResponses() {
          throw new Error('Responses adapter should not be selected')
        },
        async forwardChatCompletions(_request, reply, body) {
          forwarded = body.model === 'real-chat-model'
          await reply
            .status(200)
            .header('content-type', 'application/json')
            .send({ id: 'chatcmpl-real', choices: [] })
        }
      }
    })
    try {
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
      const response = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'x-ai-editor-device-session': tokens.deviceSessionId,
          'x-ai-editor-turn-id': 'turn_chat_12345678'
        },
        payload: { model: 'real-chat-model', messages: [], stream: false }
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().id).toBe('chatcmpl-real')
      expect(forwarded).toBe(true)
    } finally {
      await fixture.gateway.close()
    }
  })
})
