import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createEdgeServer } from '../src/edge/edge-server.js'

const contract = JSON.parse(fs.readFileSync(
  new URL('../gateway/tests/fixtures/edge-code-contract.json', import.meta.url),
  'utf8'
))

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
    assert.equal(denied.status, contract.localAuthorization.missingStatus)
    assert.equal(denied.body.error.code, contract.localAuthorization.missingErrorCode)
    const accepted = await request(port, 'GET', '/ai-editor/status', null, {
      [contract.localAuthorization.headerName]: nonce
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.state, 'ready')
    assert.equal(accepted.headers['cache-control'], 'no-store')
  })

  it('creates and consumes a one-time local handoff', async () => {
    const port = await start()
    const headers = { 'x-ai-editor-local-nonce': nonce }
    const created = await request(
      port,
      contract.handoff.start.method,
      contract.handoff.start.path,
      {
      state: contract.handoff.start.request.state
    }, headers)
    assert.ok(contract.handoff.start.successStatuses.includes(created.status))
    for (const field of contract.handoff.start.responseRequiredFields) {
      assert.ok(Object.hasOwn(created.body, field))
    }
    const completed = await request(port, contract.handoff.complete.method, contract.handoff.complete.path, {
      handoffId: created.body.handoffId,
      nonce: created.body.nonce,
      state: contract.handoff.start.request.state,
      ...contract.handoff.complete.request
    }, headers)
    assert.equal(completed.body.status, contract.handoff.complete.response.status)
    assert.ok(completed.body.bindingVersion >= contract.handoff.complete.response.minimumBindingVersion)
    const replay = await request(port, contract.handoff.complete.method, contract.handoff.complete.path, {
      handoffId: created.body.handoffId,
      nonce: created.body.nonce,
      state: contract.handoff.start.request.state,
      ...contract.handoff.complete.request
    }, headers)
    assert.ok(contract.handoff.complete.replayStatuses.includes(replay.status))
    assert.equal(replay.body.error.code, contract.handoff.complete.replayErrorCode)
  })

  it('supports Webview ticket, logout, status retry, and safe models', async () => {
    const port = await start()
    const headers = { 'x-ai-editor-local-nonce': nonce }
    assert.ok(contract.models.successStatuses.includes(
      (await request(port, contract.models.method, contract.models.path)).status
    ))
    const ticket = await request(
      port,
      contract.webviewTicket.method,
      contract.webviewTicket.path,
      {},
      headers
    )
    assert.ok(contract.webviewTicket.successStatuses.includes(ticket.status))
    assert.equal(ticket.body.expiresIn, 60)
    assert.ok(contract.statusRetry.successStatuses.includes(
      (await request(port, contract.statusRetry.method, contract.statusRetry.path, {}, headers)).status
    ))
    assert.ok(contract.logout.successStatuses.includes(
      (await request(port, contract.logout.method, contract.logout.path, {}, headers)).status
    ))
    assert.equal((await request(port, 'GET', '/ai-editor/status', null, headers)).body.state, 'login_required')
    const models = await request(port, contract.models.method, contract.models.path)
    assert.ok(contract.models.loggedOutStatuses.includes(models.status))
    assert.equal(models.body.error.code, contract.models.loggedOutErrorCode)
  })
})
