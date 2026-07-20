import crypto from 'node:crypto'
import http from 'node:http'
import Fastify from 'fastify'
import { ProviderWorkerClient } from '../../src/provider-worker/provider-worker-client.js'

const SIGNING_SECRET = 'provider-worker-gateway-test-secret-32bytes-minimum'

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not listen')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

describe('ProviderWorkerClient', () => {
  it('signs model requests and validates the safe model catalog', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {}
    const worker = http.createServer(async (request, response) => {
      capturedHeaders = request.headers
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        object: 'list',
        data: [{
          id: 'gpt-worker-mock',
          object: 'model',
          owned_by: 'ai-editor-provider-worker'
        }]
      }))
    })
    const origin = await listen(worker)
    try {
      const client = new ProviderWorkerClient({
        origin,
        gatewayId: 'gateway-test',
        signingSecret: SIGNING_SECRET,
        tls: null
      }, () => 1_800_000_000_000)
      await expect(client.listModels()).resolves.toEqual({
        object: 'list',
        data: [{
          id: 'gpt-worker-mock',
          object: 'model',
          owned_by: 'ai-editor-provider-worker'
        }]
      })
      expect(capturedHeaders['x-ai-editor-gateway-id']).toBe('gateway-test')
      expect(capturedHeaders['x-ai-editor-body-sha256']).toBe(
        crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
      )
      expect(capturedHeaders['x-ai-editor-signature']).toMatch(/^v1=[a-f0-9]{64}$/)
    } finally {
      await close(worker)
    }
  })

  it('relays SSE and returns completed usage for Gateway settlement', async () => {
    let capturedBody = ''
    let capturedTurnId = ''
    const worker = http.createServer(async (request, response) => {
      capturedTurnId = String(request.headers['x-ai-editor-turn-id'] || '')
      for await (const chunk of request) capturedBody += chunk.toString('utf8')
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'x-ai-editor-provider-id': 'provider-worker-mock'
      })
      response.write('event: response.output_text.delta\n')
      response.write('data: {"type":"response.output_text.delta","delta":"HELLO"}\n\n')
      response.end(
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"HELLO"}]}],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n'
      )
    })
    const workerOrigin = await listen(worker)
    const client = new ProviderWorkerClient({
      origin: workerOrigin,
      gatewayId: 'gateway-test',
      signingSecret: SIGNING_SECRET,
      tls: null
    })
    const gateway = Fastify({ logger: false })
    let result: unknown
    gateway.post('/v1/responses', async (request, reply) => {
      result = await client.forwardResponses(
        request,
        reply,
        request.body as Record<string, unknown>
      )
    })
    await gateway.listen({ host: '127.0.0.1', port: 0 })
    try {
      const address = gateway.server.address()
      if (!address || typeof address === 'string') throw new Error('Gateway did not listen')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ai-editor-turn-id': 'turn_gateway_worker'
        },
        body: JSON.stringify({ model: 'gpt-worker-mock', input: 'hello' })
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-ai-editor-provider-id')).toBe('provider-worker-mock')
      await expect(response.text()).resolves.toContain('response.completed')
      expect(capturedTurnId).toBe('turn_gateway_worker')
      expect(JSON.parse(capturedBody)).toEqual({
        model: 'gpt-worker-mock',
        input: 'hello'
      })
      expect(result).toEqual({
        providerId: 'provider-worker-mock',
        assistantText: 'HELLO',
        usage: { inputTokens: 7, outputTokens: 3 }
      })
    } finally {
      await gateway.close()
      await close(worker)
    }
  })

  it('syncs only the ChatGPT subscription runtime and exposes safe pool operations', async () => {
    const requests: Array<{
      method: string
      url: string
      body: string
      turnId: string
    }> = []
    const worker = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk.toString('utf8')
      requests.push({
        method: String(request.method),
        url: String(request.url),
        body,
        turnId: String(request.headers['x-ai-editor-turn-id'] || '')
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url === '/internal/v1/runtime/chatgpt-sub/accounts') {
        response.end(JSON.stringify({
          strategy: 'headroom',
          accounts: [],
          queueDepth: 0,
          recentRouteDecisions: []
        }))
        return
      }
      if (request.url === '/internal/v1/diagnostics') {
        response.end(JSON.stringify({ providers: {}, circuits: [] }))
        return
      }
      response.end(JSON.stringify({ status: 'ok' }))
    })
    const origin = await listen(worker)
    try {
      const client = new ProviderWorkerClient({
        origin,
        gatewayId: 'gateway-test',
        signingSecret: SIGNING_SECRET,
        tls: null
      })
      await client.configureProviders({
        deepseekApiKey: 'must-not-leave-gateway',
        deepseekUrl: 'https://api.deepseek.example/messages',
        openaiApiKey: 'must-not-leave-gateway-either',
        openaiApiBaseUrl: 'https://api.openai.example/v1',
        chatgptResponsesUrl: 'https://chatgpt.example/backend-api/codex/responses',
        chatgptAccounts: [{
          id: 'credential-one',
          account_id: 'account-one',
          access_token: 'subscription-access',
          refresh_token: 'subscription-refresh',
          routing_enabled: true
        }],
        chatgptAccountStrategy: 'headroom',
        relays: [{
          id: 'relay-one',
          name: 'Relay',
          base_url: 'https://relay.example',
          api_key: 'must-not-leave-gateway-relay',
          models: ['relay-model']
        }],
        fallbackChain: [{
          provider: 'chatgpt-sub',
          model: 'gpt-5.6-sol'
        }, {
          provider: 'openai-api',
          model: 'openai-api-gpt-5.6-sol'
        }],
        modelIds: ['gpt-5.6-sol', 'openai-api-gpt-5.6-sol', 'deepseek-v4-pro']
      })
      const configuration = JSON.parse(requests[0].body)
      expect(requests[0]).toMatchObject({
        method: 'PUT',
        url: '/internal/v1/runtime/chatgpt-sub',
        turnId: ''
      })
      expect(configuration).toMatchObject({
        schemaVersion: 1,
        provider: 'chatgpt-sub',
        enabled: true,
        experimental: true,
        modelIds: ['gpt-5.6-sol']
      })
      expect(JSON.stringify(configuration)).not.toContain('must-not-leave-gateway')
      expect(JSON.stringify(configuration)).toContain('subscription-access')

      await expect(client.safeAccountPool()).resolves.toMatchObject({
        strategy: 'headroom',
        accounts: []
      })
      await expect(client.safeDiagnostics()).resolves.toEqual({
        providers: {},
        circuits: []
      })
      await client.refreshChatgptAccountUsage('credential-one')
      expect(requests.at(-1)).toMatchObject({
        method: 'POST',
        url: '/internal/v1/runtime/chatgpt-sub/accounts/credential-one/refresh-usage',
        turnId: ''
      })
    } finally {
      await close(worker)
    }
  })

  it('maps Worker errors without exposing its response message', async () => {
    const worker = http.createServer((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: {
          code: 'worker_turn_conflict',
          message: 'internal-sensitive-detail',
          retryable: false
        }
      }))
    })
    const origin = await listen(worker)
    try {
      const client = new ProviderWorkerClient({
        origin,
        gatewayId: 'gateway-test',
        signingSecret: SIGNING_SECRET,
        tls: null
      })
      await expect(client.listModels()).rejects.toMatchObject({
        code: 'worker_turn_conflict',
        statusCode: 409,
        retryable: false,
        message: '境外模型通道拒绝了本次请求。'
      })
    } finally {
      await close(worker)
    }
  })
})
