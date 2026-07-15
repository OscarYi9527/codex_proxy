import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createEdgeServer } from '../src/edge/edge-server.js'

const nonce = 'test-local-nonce-32-bytes-minimum'
const config = {
  host: '127.0.0.1',
  port: 47921,
  gatewayOrigin: 'http://127.0.0.1:47920',
  dataRoot: 'unused-test-data-root',
  localNonce: nonce,
  mockState: 'ready'
}

const servers = []

async function start() {
  const edge = createEdgeServer({ config })
  await new Promise((resolve, reject) => {
    edge.server.once('error', reject)
    edge.server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(edge.server)
  return edge.server.address().port
}

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        host: '127.0.0.1:47921',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('Edge first-round Mock API', () => {
  it('exposes safe liveness but protects product-local endpoints with a nonce', async () => {
    const port = await start()
    assert.equal((await request(port, 'GET', '/live')).status, 200)
    const denied = await request(port, 'GET', '/ai-editor/status')
    assert.equal(denied.status, 401)
    const accepted = await request(port, 'GET', '/ai-editor/status', null, {
      'x-ai-editor-local-nonce': nonce
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.state, 'ready')
    assert.equal(accepted.headers['cache-control'], 'no-store')
  })

  it('creates and consumes a one-time local handoff', async () => {
    const port = await start()
    const headers = { 'x-ai-editor-local-nonce': nonce }
    const created = await request(port, 'POST', '/ai-editor/handoff/start', {
      state: 'code-login-state'
    }, headers)
    assert.equal(created.status, 201)
    const completed = await request(port, 'POST', '/ai-editor/handoff/complete', {
      handoffId: created.body.handoffId,
      nonce: created.body.nonce,
      state: 'code-login-state',
      deviceSessionId: 'ds_mock',
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
      accessTokenExpiresIn: 300
    }, headers)
    assert.deepEqual(completed.body, { status: 'completed', bindingVersion: 1 })
    const replay = await request(port, 'POST', '/ai-editor/handoff/complete', {
      handoffId: created.body.handoffId,
      nonce: created.body.nonce,
      state: 'code-login-state',
      deviceSessionId: 'ds_mock',
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret'
    }, headers)
    assert.equal(replay.status, 400)
    assert.equal(replay.body.error.code, 'handoff_invalid')
  })

  it('supports Webview ticket, logout, status retry, and safe models', async () => {
    const port = await start()
    const headers = { 'x-ai-editor-local-nonce': nonce }
    assert.equal((await request(port, 'GET', '/v1/models')).status, 200)
    const ticket = await request(port, 'POST', '/ai-editor/webview-ticket', {}, headers)
    assert.equal(ticket.status, 200)
    assert.equal(ticket.body.expiresIn, 60)
    assert.equal((await request(port, 'POST', '/ai-editor/status/retry', {}, headers)).status, 200)
    assert.equal((await request(port, 'POST', '/ai-editor/logout', {}, headers)).status, 204)
    assert.equal((await request(port, 'GET', '/ai-editor/status', null, headers)).body.state, 'login_required')
    const models = await request(port, 'GET', '/v1/models')
    assert.equal(models.status, 401)
    assert.equal(models.body.error.code, 'login_required')
  })
})
