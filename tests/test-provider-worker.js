import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import forge from 'node-forge'
import {
  loadProviderWorkerConfig,
  PROVIDER_WORKER_DEVELOPMENT_PORT
} from '../src/provider-worker/config.js'
import {
  createProviderWorkerSignedHeaders,
  sha256Hex,
  verifyProviderWorkerRequest
} from '../src/provider-worker/protocol.js'
import { NonceStore } from '../src/provider-worker/nonce-store.js'
import { TurnStore } from '../src/provider-worker/turn-store.js'
import { createProviderWorkerServer } from '../src/provider-worker/server.js'

const SIGNING_SECRET = 'provider-worker-test-secret-with-at-least-32-bytes'
const openWorkers = new Set()
const temporaryDirectories = new Set()

function certificate(options) {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const value = forge.pki.createCertificate()
  value.publicKey = keys.publicKey
  value.serialNumber = options.serial
  value.validity.notBefore = new Date(Date.now() - 60_000)
  value.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000)
  value.setSubject([{ name: 'commonName', value: options.commonName }])
  value.setIssuer(options.issuerCertificate
    ? options.issuerCertificate.subject.attributes
    : value.subject.attributes)
  value.setExtensions(options.extensions)
  value.sign(options.issuerKey || keys.privateKey, forge.md.sha256.create())
  return { certificate: value, keys }
}

function createMtlsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-mtls-'))
  temporaryDirectories.add(root)
  const ca = certificate({
    serial: '01',
    commonName: 'AI Editor Test CA',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
    ]
  })
  const server = certificate({
    serial: '02',
    commonName: '127.0.0.1',
    issuerCertificate: ca.certificate,
    issuerKey: ca.keys.privateKey,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 7, ip: '127.0.0.1' }]
      }
    ]
  })
  const client = certificate({
    serial: '03',
    commonName: 'gateway-test',
    issuerCertificate: ca.certificate,
    issuerKey: ca.keys.privateKey,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', clientAuth: true }
    ]
  })
  const files = {
    ca: path.join(root, 'ca.pem'),
    serverKey: path.join(root, 'server-key.pem'),
    serverCert: path.join(root, 'server-cert.pem'),
    clientKey: path.join(root, 'client-key.pem'),
    clientCert: path.join(root, 'client-cert.pem')
  }
  fs.writeFileSync(files.ca, forge.pki.certificateToPem(ca.certificate))
  fs.writeFileSync(files.serverKey, forge.pki.privateKeyToPem(server.keys.privateKey))
  fs.writeFileSync(files.serverCert, forge.pki.certificateToPem(server.certificate))
  fs.writeFileSync(files.clientKey, forge.pki.privateKeyToPem(client.keys.privateKey))
  fs.writeFileSync(files.clientCert, forge.pki.certificateToPem(client.certificate))
  return files
}

function httpsGet(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, options, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    request.once('error', reject)
  })
}

function testConfig(overrides = {}) {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: PROVIDER_WORKER_DEVELOPMENT_PORT,
    dataRoot: path.resolve('.ai-editor-dev', 'provider-worker-test'),
    signingSecret: SIGNING_SECRET,
    allowedGatewayIds: new Set(['gateway-test']),
    maxClockSkewMs: 60_000,
    nonceTtlMs: 120_000,
    turnTtlMs: 900_000,
    tls: null,
    ...overrides
  }
}

async function startWorker(options = {}) {
  const worker = createProviderWorkerServer({
    config: testConfig(),
    ...options
  })
  await new Promise((resolve, reject) => {
    worker.server.once('error', reject)
    worker.server.listen(0, '127.0.0.1', resolve)
  })
  openWorkers.add(worker)
  const address = worker.server.address()
  return {
    worker,
    origin: `http://127.0.0.1:${address.port}`
  }
}

function signedRequest(origin, requestTarget, options = {}) {
  const method = options.method || 'GET'
  const body = options.body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(options.body), 'utf8')
  const turnId = options.turnId || ''
  const headers = createProviderWorkerSignedHeaders({
    method,
    requestTarget,
    gatewayId: 'gateway-test',
    requestId: options.requestId || `req_${crypto.randomUUID().replaceAll('-', '')}`,
    turnId,
    body,
    signingSecret: SIGNING_SECRET,
    timestamp: options.timestamp,
    nonce: options.nonce
  })
  return {
    body,
    headers,
    fetch: () => fetch(new URL(requestTarget, origin), {
      method,
      headers: {
        ...headers,
        accept: options.accept || 'application/json',
        ...(body.length ? { 'content-type': 'application/json' } : {})
      },
      ...(body.length ? { body } : {})
    })
  }
}

afterEach(async () => {
  for (const worker of openWorkers) {
    await worker.close()
    openWorkers.delete(worker)
  }
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true })
    temporaryDirectories.delete(directory)
  }
})

describe('Provider Worker configuration and signed protocol', () => {
  it('matches the shared Gateway/Worker v1 signing fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.resolve('gateway/tests/fixtures/provider-worker-signing-v1.json'),
      'utf8'
    ))
    const body = Buffer.from(fixture.body, 'utf8')
    const headers = createProviderWorkerSignedHeaders({
      method: fixture.method,
      requestTarget: fixture.requestTarget,
      gatewayId: fixture.gatewayId,
      requestId: fixture.requestId,
      turnId: fixture.turnId,
      body,
      signingSecret: fixture.signingSecret,
      timestamp: fixture.timestamp,
      nonce: fixture.nonce
    })
    assert.equal(headers['x-ai-editor-body-sha256'], fixture.bodySha256)
    assert.equal(headers['x-ai-editor-signature'], fixture.signature)
    body.fill(0)
  })

  it('uses isolated fixed development defaults and requires a strong signing secret', () => {
    const repositoryRoot = path.resolve('D:/example/codex-proxy')
    const config = loadProviderWorkerConfig({
      NODE_ENV: 'development',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET
    }, { repositoryRoot })
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 47930)
    assert.equal(
      config.dataRoot,
      path.join(repositoryRoot, '.ai-editor-dev', 'provider-worker')
    )
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'development',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: 'short'
    }, { repositoryRoot }), /at least 32 bytes/)
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'development',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_PORT: '47892'
    }, { repositoryRoot }), /Invalid Provider Worker port/)
  })

  it('requires all mTLS files before production can start', () => {
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'production',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_DATA_ROOT: path.resolve('.worker-production')
    }), /requires mTLS/)
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'development',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_TLS_KEY: 'key.pem'
    }), /configured together/)
  })

  it('detects body, timestamp, gateway and signature tampering', () => {
    const now = 1_800_000_000_000
    const body = Buffer.from('{"model":"gpt-worker-mock"}')
    const headers = createProviderWorkerSignedHeaders({
      method: 'POST',
      requestTarget: '/internal/v1/responses',
      gatewayId: 'gateway-test',
      requestId: 'req_test',
      turnId: 'turn_test',
      body,
      signingSecret: SIGNING_SECRET,
      timestamp: now,
      nonce: 'nonce_1234567890123456'
    })
    const verified = verifyProviderWorkerRequest({
      method: 'POST',
      requestTarget: '/internal/v1/responses',
      headers,
      body,
      signingSecret: SIGNING_SECRET,
      allowedGatewayIds: new Set(['gateway-test']),
      now: () => now,
      maxClockSkewMs: 60_000
    })
    assert.equal(verified.turnId, 'turn_test')
    assert.equal(verified.bodySha256, sha256Hex(body))
    assert.throws(() => verifyProviderWorkerRequest({
      method: 'POST',
      requestTarget: '/internal/v1/responses',
      headers,
      body: Buffer.from('{}'),
      signingSecret: SIGNING_SECRET,
      allowedGatewayIds: new Set(['gateway-test']),
      now: () => now,
      maxClockSkewMs: 60_000
    }), error => error.code === 'worker_body_digest_invalid')
    assert.throws(() => verifyProviderWorkerRequest({
      method: 'POST',
      requestTarget: '/internal/v1/responses',
      headers,
      body,
      signingSecret: SIGNING_SECRET,
      allowedGatewayIds: new Set(['another-gateway']),
      now: () => now,
      maxClockSkewMs: 60_000
    }), error => error.code === 'worker_gateway_forbidden')
    assert.throws(() => verifyProviderWorkerRequest({
      method: 'POST',
      requestTarget: '/internal/v1/responses',
      headers,
      body,
      signingSecret: SIGNING_SECRET,
      allowedGatewayIds: new Set(['gateway-test']),
      now: () => now + 60_001,
      maxClockSkewMs: 60_000
    }), error => error.code === 'worker_request_expired')
  })

  it('rejects a consumed nonce and expires old nonce records', () => {
    let now = 1_000
    const store = new NonceStore({ now: () => now, ttlMs: 100 })
    assert.equal(store.consume('gateway-test', 'nonce-a'), true)
    assert.equal(store.consume('gateway-test', 'nonce-a'), false)
    assert.equal(store.consume('gateway-other', 'nonce-a'), true)
    now += 101
    assert.equal(store.consume('gateway-test', 'nonce-a'), true)
  })
})

describe('Provider Worker local lifecycle', () => {
  it('requires a CA-authorized Gateway client certificate on the real TLS socket', async () => {
    const files = createMtlsFixture()
    const { worker } = await startWorker({
      config: testConfig({
        tls: {
          keyFile: files.serverKey,
          certFile: files.serverCert,
          caFile: files.ca
        }
      })
    })
    const address = worker.server.address()
    const origin = `https://127.0.0.1:${address.port}`
    const accepted = await httpsGet(`${origin}/live`, {
      key: fs.readFileSync(files.clientKey),
      cert: fs.readFileSync(files.clientCert),
      ca: fs.readFileSync(files.ca),
      rejectUnauthorized: true
    })
    assert.equal(accepted.statusCode, 200)
    assert.equal(JSON.parse(accepted.body).mode, 'provider-worker')
    await assert.rejects(
      httpsGet(`${origin}/live`, {
        ca: fs.readFileSync(files.ca),
        rejectUnauthorized: true
      }),
      /certificate|alert|socket|reset/i
    )
  })

  it('exposes only minimal unsigned health and a signed model catalog', async () => {
    const { origin } = await startWorker()
    const live = await fetch(`${origin}/live`)
    assert.equal(live.status, 200)
    assert.deepEqual(await live.json(), {
      status: 'ok',
      service: 'ai-editor-provider-worker',
      mode: 'provider-worker'
    })
    const unsigned = await fetch(`${origin}/internal/v1/models`)
    assert.equal(unsigned.status, 401)
    assert.equal((await unsigned.json()).error.code, 'worker_authentication_invalid')

    const request = signedRequest(origin, '/internal/v1/models')
    const response = await request.fetch()
    request.body.fill(0)
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data.map(model => model.id), ['gpt-worker-mock'])
  })

  it('rejects nonce replay before executing a second request', async () => {
    const { origin } = await startWorker()
    const first = signedRequest(origin, '/internal/v1/models', {
      nonce: 'nonce_replay_1234567890',
      requestId: 'req_replay'
    })
    const firstResponse = await first.fetch()
    assert.equal(firstResponse.status, 200)
    const replay = await first.fetch()
    first.body.fill(0)
    assert.equal(replay.status, 409)
    assert.equal((await replay.json()).error.code, 'worker_replay_detected')
  })

  it('streams a mock response and safely replays an identical completed Turn', async () => {
    const { origin } = await startWorker()
    const turnId = 'turn_stream_replay'
    const body = {
      model: 'gpt-worker-mock',
      input: 'hello',
      mockText: 'WORKER_STREAM_OK',
      mockChunkDelayMs: 2
    }
    const first = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body
    })
    const response = await first.fetch()
    first.body.fill(0)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const payload = await response.text()
    assert.match(payload, /response\.created/)
    assert.match(payload, /WORKER_STREAM_OK/)
    assert.match(payload, /response\.completed/)

    const replayRequest = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body
    })
    const replay = await replayRequest.fetch()
    replayRequest.body.fill(0)
    assert.equal(replay.status, 200)
    assert.equal(replay.headers.get('x-ai-editor-idempotent-replay'), 'true')
    assert.equal(await replay.text(), payload)

    const statusRequest = signedRequest(
      origin,
      `/internal/v1/turns/${turnId}`,
      { turnId }
    )
    const status = await statusRequest.fetch()
    statusRequest.body.fill(0)
    assert.equal(status.status, 200)
    const value = await status.json()
    assert.equal(value.state, 'completed')
    assert.equal(value.providerId, 'provider-worker-mock')
    assert.ok(value.usage.inputTokens > 0)
  })

  it('rejects reuse of a Turn ID with a different body', async () => {
    const { origin } = await startWorker()
    const turnId = 'turn_conflict'
    const first = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body: { model: 'gpt-worker-mock', input: 'first' }
    })
    assert.equal((await first.fetch()).status, 200)
    first.body.fill(0)
    const conflict = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body: { model: 'gpt-worker-mock', input: 'different' }
    })
    const response = await conflict.fetch()
    conflict.body.fill(0)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'worker_turn_conflict')
  })

  it('cancels a running Turn without exposing request content in status', async () => {
    let started
    const startedPromise = new Promise(resolve => { started = resolve })
    const executor = {
      async execute({ signal }) {
        started()
        return {
          providerId: 'blocking-mock',
          usage: { inputTokens: 1, outputTokens: 0 },
          async *stream() {
            await new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => reject(Object.assign(
                new Error('cancelled'),
                { code: 'worker_turn_cancelled', statusCode: 409 }
              )), { once: true })
            })
            yield Buffer.from('')
          }
        }
      }
    }
    const { origin } = await startWorker({ executor })
    const turnId = 'turn_cancel'
    const execute = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body: { model: 'gpt-worker-mock', input: 'sensitive-content' }
    })
    const executionPromise = execute.fetch()
    await startedPromise
    const cancel = signedRequest(
      origin,
      `/internal/v1/turns/${turnId}/cancel`,
      { method: 'POST', turnId, body: {} }
    )
    const cancelResponse = await cancel.fetch()
    cancel.body.fill(0)
    assert.equal(cancelResponse.status, 202)
    const cancelled = await cancelResponse.json()
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(JSON.stringify(cancelled).includes('sensitive-content'), false)
    const execution = await executionPromise
    execute.body.fill(0)
    assert.equal(execution.status, 200)
    assert.equal(await execution.text(), '')
  })
})

describe('Provider Worker Turn store', () => {
  it('does not overwrite a cancelled Turn when an executor ignores AbortSignal', () => {
    const store = new TurnStore({ now: () => 1_000, ttlMs: 100 })
    store.begin('turn-cancelled', 'fingerprint')
    assert.equal(store.cancel('turn-cancelled').state, 'cancelled')
    assert.equal(store.complete('turn-cancelled', {
      response: Buffer.from('late'),
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'late-provider'
    }), false)
    assert.equal(store.get('turn-cancelled').state, 'cancelled')
  })

  it('clears cached response bytes after expiration', () => {
    let now = 1_000
    const store = new TurnStore({ now: () => now, ttlMs: 100 })
    const started = store.begin('turn-expire', 'fingerprint')
    assert.equal(started.state, 'started')
    store.complete('turn-expire', {
      response: Buffer.from('cached'),
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'mock'
    })
    now += 101
    assert.equal(store.get('turn-expire'), null)
  })
})
