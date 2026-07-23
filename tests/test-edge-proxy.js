import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { createEdgeServer } from '../src/edge/edge-server.js'
import {
  LocalAccountBindingStore,
  MemoryRefreshTokenStore
} from '../src/edge/local-account-store.js'
import { GatewayClient } from '../src/edge/gateway-client.js'

const nonce = 'real-edge-local-nonce-at-least-32-bytes'
const servers = []

async function start(options) {
  const edge = createEdgeServer({
    config: {
      host: '127.0.0.1',
      port: 47921,
      gatewayOrigin: 'http://127.0.0.1:47920',
      dataRoot: 'unused-test-data-root',
      localNonce: nonce,
      authMode: 'real',
      environment: 'development',
      mockState: 'login_required'
    },
    ...options
  })
  await new Promise((resolve, reject) => {
    edge.server.once('error', reject)
    edge.server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(edge.server)
  return edge.server.address().port
}

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        host: '127.0.0.1:47921',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length)
        } : {}),
        ...headers
      }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise(resolve => server.close(resolve))
  ))
})

describe('Edge real model and Responses proxy contract (T038/T041/T042)', () => {
  it('forwards non-Mock models and Responses streams through GatewayClient', async () => {
    const gatewayClient = {
      async initialize() {},
      async getSafeStatus() {
        return { state: 'ready', checkedAt: new Date().toISOString(), actions: [] }
      },
      async models() {
        return {
          object: 'list',
          data: [{ id: 'real-edge-model', object: 'model', owned_by: 'ai-editor' }]
        }
      },
      async forward(_path, _req, res, body) {
        assert.equal(body.model, 'real-edge-model')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
      },
      async logout() {},
      async requestWebviewTicket() {
        return { ticket: 'ticket', expiresIn: 60 }
      }
    }
    const port = await start({
      bindingStore: { snapshot: () => ({ bindingVersion: 1 }) },
      gatewayClient
    })
    const models = await request(port, 'GET', '/v1/models')
    assert.equal(models.status, 200)
    assert.equal(JSON.parse(models.body).data[0].id, 'real-edge-model')
    assert.doesNotMatch(models.body, /gpt-mock/)

    const stream = await request(port, 'POST', '/v1/responses', {
      model: 'real-edge-model',
      input: 'hello',
      stream: true
    })
    assert.equal(stream.status, 200)
    assert.match(stream.headers['content-type'], /text\/event-stream/)
    assert.match(stream.body, /response\.completed/)

    const ticket = await request(
      port,
      'POST',
      '/ai-editor/webview-ticket',
      {},
      { 'x-ai-editor-local-nonce': nonce }
    )
    assert.equal(ticket.status, 200)
    assert.deepEqual(JSON.parse(ticket.body), { ticket: 'ticket', expiresIn: 60 })
  })
})

describe('in-flight binding identity (T040)', () => {
  it('keeps the captured old account when the local binding changes mid-request', async () => {
    const binding = new LocalAccountBindingStore({
      secureStore: new MemoryRefreshTokenStore(),
      now: () => 100_000
    })
    await binding.completeHandoff({
      deviceSessionId: 'ds_old',
      refreshToken: 'refresh-old',
      accessToken: 'access-old',
      accessTokenExpiresIn: 300
    })
    let capturedHeaders
    let signalFetchStarted
    const fetchStarted = new Promise(resolve => { signalFetchStarted = resolve })
    let releaseFetch
    const fetchRelease = new Promise(resolve => { releaseFetch = resolve })
    const client = new GatewayClient({
      gatewayOrigin: 'http://127.0.0.1:47920',
      bindingStore: binding,
      now: () => 100_000,
      fetchImpl: async (_url, options) => {
        capturedHeaders = options.headers
        signalFetchStarted()
        await fetchRelease
        return new Response('event: response.completed\ndata: {}\n\n', {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-ai-editor-provider-id': 'chatgpt-sub',
            'x-ai-editor-worker-id': 'worker-preprod-sg',
            'x-ai-editor-worker-region': 'ap-singapore'
          }
        })
      }
    })
    const output = new PassThrough()
    output.headers = {}
    output.writeHead = (status, headers) => {
      output.statusCode = status
      output.headers = headers
    }
    const chunks = []
    output.on('data', chunk => chunks.push(chunk))
    const forwarding = client.forward(
      '/v1/responses',
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'x-ai-editor-turn-id': 'turn_identity_1234'
        }
      },
      output,
      { model: 'real-model', input: 'hello', stream: true }
    )
    await fetchStarted
    await binding.completeHandoff({
      deviceSessionId: 'ds_new',
      refreshToken: 'refresh-new',
      accessToken: 'access-new',
      accessTokenExpiresIn: 300
    })
    releaseFetch()
    await forwarding
    assert.equal(capturedHeaders.authorization, 'Bearer access-old')
    assert.equal(capturedHeaders['x-ai-editor-device-session'], 'ds_old')
    assert.equal(capturedHeaders['x-ai-editor-turn-id'], 'turn_identity_1234')
    assert.match(Buffer.concat(chunks).toString('utf8'), /response\.completed/)
    assert.equal(output.headers['x-ai-editor-provider-id'], 'chatgpt-sub')
    assert.equal(output.headers['x-ai-editor-worker-id'], 'worker-preprod-sg')
    assert.equal(output.headers['x-ai-editor-worker-region'], 'ap-singapore')
    assert.equal(binding.snapshot().deviceSessionId, 'ds_new')
  })
})
