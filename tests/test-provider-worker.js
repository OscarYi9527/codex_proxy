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
  signProviderUsageReceipt,
  verifyProviderWorkerRequest
} from '../src/provider-worker/protocol.js'
import { NonceStore } from '../src/provider-worker/nonce-store.js'
import { TurnStore } from '../src/provider-worker/turn-store.js'
import { ExecutionStore } from '../src/provider-worker/execution-store.js'
import { createProviderWorkerServer } from '../src/provider-worker/server.js'
import {
  ChatgptSubscriptionExecutor,
  safeUpstreamFailureDetails
} from '../src/provider-worker/chatgpt-sub-executor.js'
import {
  DevelopmentWorkerCredentialVault,
  loadWorkerCredentialVault
} from '../src/provider-worker/credential-vault.js'

const SIGNING_SECRET = 'provider-worker-test-secret-with-at-least-32-bytes'
const openWorkers = new Set()
const temporaryDirectories = new Set()

describe('Provider Worker safe upstream diagnostics', () => {
  it('classifies a rejected field without logging the rejected value', () => {
    const secret = 'sk-sensitive-value-that-must-not-appear'
    const body = Buffer.from(JSON.stringify({
      error: {
        code: 'invalid_request_error',
        type: 'invalid_request_error',
        param: 'instructions',
        message: `Invalid instructions value '${secret}'`
      }
    }))
    const bodyBytes = body.length
    const details = safeUpstreamFailureDetails(400, body)
    body.fill(0)
    assert.deepEqual(details, {
      statusCode: 400,
      code: 'invalid_request_error',
      type: 'invalid_request_error',
      param: 'instructions',
      category: 'invalid_value',
      bodyBytes
    })
    assert.equal(JSON.stringify(details).includes(secret), false)
  })
})

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
    workerId: 'worker-local',
    region: 'local-development',
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
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-state-'))
  temporaryDirectories.add(dataRoot)
  const { config: configOverrides = {}, ...serverOptions } = options
  const worker = createProviderWorkerServer({
    config: testConfig({ dataRoot, ...configOverrides }),
    ...serverOptions
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
    assert.equal(config.executorMode, 'mock')
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
    assert.equal(loadProviderWorkerConfig({
      NODE_ENV: 'development',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_EXECUTOR: 'chatgpt-sub'
    }, { repositoryRoot }).executorMode, 'chatgpt-sub')
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'development',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_EXECUTOR: 'unknown'
    }, { repositoryRoot }), /Unsupported Provider Worker executor/)
  })

  it('keeps preview Worker traffic on fixed loopback without production mTLS', () => {
    const repositoryRoot = path.resolve('D:/example/codex-proxy')
    const config = loadProviderWorkerConfig({
      NODE_ENV: 'preview',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_EXECUTOR: 'chatgpt-sub'
    }, { repositoryRoot })
    assert.equal(config.environment, 'preview')
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 47930)
    assert.equal(config.tls, null)
    assert.equal(
      config.dataRoot,
      path.join(repositoryRoot, '.ai-editor-dev', 'provider-worker')
    )
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'preview',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_HOST: '0.0.0.0'
    }, { repositoryRoot }), /127\.0\.0\.1/)
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

  it('requires mTLS and permits a public listener in preproduction', () => {
    const repositoryRoot = path.resolve('D:/example/codex-proxy')
    const files = createMtlsFixture()
    const dataRoot = path.join(
      repositoryRoot,
      '.ai-editor-dev',
      'preproduction',
      'provider-worker'
    )
    const config = loadProviderWorkerConfig({
      NODE_ENV: 'preproduction',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_EXECUTOR: 'chatgpt-sub',
      AI_EDITOR_PROVIDER_WORKER_HOST: '0.0.0.0',
      AI_EDITOR_PROVIDER_WORKER_PORT: '47930',
      AI_EDITOR_PROVIDER_WORKER_DATA_ROOT: dataRoot,
      AI_EDITOR_PROVIDER_WORKER_TLS_KEY: files.serverKey,
      AI_EDITOR_PROVIDER_WORKER_TLS_CERT: files.serverCert,
      AI_EDITOR_PROVIDER_WORKER_TLS_CA: files.ca
    }, { repositoryRoot })
    assert.equal(config.environment, 'preproduction')
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 47930)
    assert.equal(config.executorMode, 'chatgpt-sub')
    assert.deepEqual(config.tls, {
      keyFile: path.resolve(files.serverKey),
      certFile: path.resolve(files.serverCert),
      caFile: path.resolve(files.ca)
    })
    assert.throws(() => loadProviderWorkerConfig({
      NODE_ENV: 'preproduction',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: SIGNING_SECRET,
      AI_EDITOR_PROVIDER_WORKER_DATA_ROOT: dataRoot
    }, { repositoryRoot }), /requires mTLS/)
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

  it('persists signed usage outbox records and acknowledges settlement across restarts', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-restart-'))
    temporaryDirectories.add(dataRoot)
    const turnId = 'turn_persistent_outbox'
    const requestBody = {
      model: 'gpt-worker-mock',
      input: 'sensitive-prompt-must-not-be-persisted',
      mockText: 'sensitive-response-must-not-be-persisted'
    }
    const first = await startWorker({ config: { dataRoot } })
    const execute = signedRequest(first.origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body: requestBody
    })
    const response = await execute.fetch()
    execute.body.fill(0)
    assert.equal(response.status, 200)
    const outboxId = response.headers.get('x-ai-editor-outbox-id')
    const executionId = response.headers.get('x-ai-editor-execution-id')
    assert.match(outboxId, /^outbox_[a-f0-9]{32}$/)
    assert.match(executionId, /^exec_[a-f0-9]{32}$/)
    await response.text()

    const statusRequest = signedRequest(
      first.origin,
      `/internal/v1/turns/${turnId}`,
      { turnId }
    )
    const statusResponse = await statusRequest.fetch()
    statusRequest.body.fill(0)
    const status = await statusResponse.json()
    assert.equal(status.state, 'completed')
    assert.equal(status.usageReceipt.outboxId, outboxId)
    const { schemaVersion, signature, ...unsignedReceipt } = status.usageReceipt
    assert.equal(schemaVersion, 1)
    assert.equal(
      signature,
      signProviderUsageReceipt(unsignedReceipt, SIGNING_SECRET)
    )

    const stateFile = path.join(dataRoot, 'provider-worker-executions-v1.json')
    const storedBeforeRestart = fs.readFileSync(stateFile, 'utf8')
    assert.equal(storedBeforeRestart.includes(requestBody.input), false)
    assert.equal(storedBeforeRestart.includes(requestBody.mockText), false)
    assert.equal(storedBeforeRestart.includes('access_token'), false)
    assert.equal(storedBeforeRestart.includes('refresh_token'), false)

    await first.worker.close()
    openWorkers.delete(first.worker)
    const second = await startWorker({ config: { dataRoot } })
    const outboxRequest = signedRequest(
      second.origin,
      '/internal/v1/usage/outbox?limit=10'
    )
    const outboxResponse = await outboxRequest.fetch()
    outboxRequest.body.fill(0)
    assert.equal(outboxResponse.status, 200)
    const outbox = await outboxResponse.json()
    assert.equal(outbox.items.length, 1)
    assert.equal(outbox.items[0].outboxId, outboxId)
    assert.equal(outbox.items[0].signature, signature)

    const duplicate = signedRequest(second.origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body: requestBody
    })
    const duplicateResponse = await duplicate.fetch()
    duplicate.body.fill(0)
    assert.equal(duplicateResponse.status, 409)
    assert.equal(
      (await duplicateResponse.json()).error.code,
      'worker_turn_completed_pending_settlement'
    )

    const acknowledgement = {
      schemaVersion: 1,
      acknowledgements: [{
        outboxId,
        turnId,
        settlementId: 'usage_gateway_persisted',
        settledAt: new Date().toISOString()
      }]
    }
    const rejectedBatch = signedRequest(
      second.origin,
      '/internal/v1/usage/outbox/ack',
      {
        method: 'POST',
        body: {
          schemaVersion: 1,
          acknowledgements: [
            ...acknowledgement.acknowledgements,
            {
              outboxId: 'outbox_missing',
              turnId: 'turn_missing',
              settlementId: 'usage_missing',
              settledAt: new Date().toISOString()
            }
          ]
        }
      }
    )
    const rejectedBatchResponse = await rejectedBatch.fetch()
    rejectedBatch.body.fill(0)
    assert.equal(rejectedBatchResponse.status, 404)
    const stillPendingRequest = signedRequest(
      second.origin,
      '/internal/v1/usage/outbox?limit=10'
    )
    const stillPendingResponse = await stillPendingRequest.fetch()
    stillPendingRequest.body.fill(0)
    assert.equal((await stillPendingResponse.json()).items.length, 1)

    const ackRequest = signedRequest(
      second.origin,
      '/internal/v1/usage/outbox/ack',
      { method: 'POST', body: acknowledgement }
    )
    const ackResponse = await ackRequest.fetch()
    ackRequest.body.fill(0)
    assert.equal(ackResponse.status, 200)
    assert.deepEqual((await ackResponse.json()).acknowledged, [outboxId])

    const retryAck = signedRequest(
      second.origin,
      '/internal/v1/usage/outbox/ack',
      { method: 'POST', body: acknowledgement }
    )
    const retryAckResponse = await retryAck.fetch()
    retryAck.body.fill(0)
    assert.equal(retryAckResponse.status, 200)
    assert.deepEqual(
      (await retryAckResponse.json()).alreadyAcknowledged,
      [outboxId]
    )

    await second.worker.close()
    openWorkers.delete(second.worker)
    const third = await startWorker({ config: { dataRoot } })
    const emptyRequest = signedRequest(
      third.origin,
      '/internal/v1/usage/outbox?limit=10'
    )
    const emptyResponse = await emptyRequest.fetch()
    emptyRequest.body.fill(0)
    assert.equal(emptyResponse.status, 200)
    assert.deepEqual((await emptyResponse.json()).items, [])
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

  it('returns bounded circuit recovery metadata without leaking internals', async () => {
    const executor = {
      async supportsModel() {
        return true
      },
      async execute() {
        throw Object.assign(new Error('sensitive upstream circuit detail'), {
          code: 'CIRCUIT_OPEN',
          status: 503,
          statusCode: 503,
          retryable: true,
          retryAfterMs: 4_200
        })
      }
    }
    const { origin } = await startWorker({ executor })
    const request = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId: 'turn_circuit_recovery',
      body: { model: 'gpt-worker-mock', input: 'hello' }
    })
    const response = await request.fetch()
    request.body.fill(0)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '5')
    const body = await response.json()
    assert.equal(body.error.code, 'upstream_recovering')
    assert.equal(body.error.retryable, true)
    assert.equal(body.error.retryAfterMs, 4_200)
    assert.doesNotMatch(body.error.message, /sensitive/)
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

describe('Provider Worker ChatGPT subscription runtime', () => {
  it('restores refreshed credentials securely across restarts and key rotation', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-vault-'))
    temporaryDirectories.add(dataRoot)
    const options = {
      dataRoot,
      workerId: 'worker-vault-test',
      region: 'local-development'
    }
    const first = new DevelopmentWorkerCredentialVault(options)
    await first.snapshot([{
      id: 'account-vault',
      credential_version: 1,
      access_token: 'access-original-secret',
      refresh_token: 'refresh-original-secret'
    }])
    await first.snapshot([{
      id: 'account-vault',
      credential_version: 1,
      access_token: 'access-refreshed-secret',
      refresh_token: 'refresh-rotated-secret'
    }])
    const stored = fs.readFileSync(
      path.join(dataRoot, 'provider-worker-chatgpt-credentials-v1.json'),
      'utf8'
    )
    for (const secret of [
      'access-original-secret',
      'refresh-original-secret',
      'access-refreshed-secret',
      'refresh-rotated-secret'
    ]) {
      assert.equal(stored.includes(secret), false)
    }

    const restarted = new DevelopmentWorkerCredentialVault(options)
    const restored = await restarted.restore([{
      id: 'account-vault',
      credential_version: 1,
      access_token: 'stale-gateway-access',
      refresh_token: 'stale-gateway-refresh'
    }])
    assert.equal(restored[0].access_token, 'access-refreshed-secret')
    assert.equal(restored[0].refresh_token, 'refresh-rotated-secret')

    const replaced = await restarted.restore([{
      id: 'account-vault',
      credential_version: 2,
      access_token: 'admin-replacement-access',
      refresh_token: 'admin-replacement-refresh'
    }])
    assert.equal(replaced[0].access_token, 'admin-replacement-access')
    assert.equal(replaced[0].refresh_token, 'admin-replacement-refresh')

    const oldVersion = await restarted.currentKeyVersion()
    const newVersion = await restarted.rotate()
    assert.notEqual(newVersion, oldVersion)
    const afterRotation = await new DevelopmentWorkerCredentialVault(options)
      .restore([{
        id: 'account-vault',
        credential_version: 1,
        access_token: 'stale',
        refresh_token: 'stale'
      }])
    assert.equal(afterRotation[0].refresh_token, 'refresh-rotated-secret')

    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-vault-backup-'))
    temporaryDirectories.add(backupRoot)
    for (const file of [
      'provider-worker-credential-master-keys.worker-secret',
      'provider-worker-chatgpt-credentials-v1.json'
    ]) {
      fs.copyFileSync(path.join(dataRoot, file), path.join(backupRoot, file))
    }
    const restoredBackup = await new DevelopmentWorkerCredentialVault({
      ...options,
      dataRoot: backupRoot
    }).restore([{
      id: 'account-vault',
      credential_version: 1,
      access_token: 'stale',
      refresh_token: 'stale'
    }])
    assert.equal(restoredBackup[0].refresh_token, 'refresh-rotated-secret')

    const vaultFile = path.join(
      backupRoot,
      'provider-worker-chatgpt-credentials-v1.json'
    )
    const tampered = JSON.parse(fs.readFileSync(vaultFile, 'utf8'))
    tampered.records[0].payload.tag = Buffer.alloc(16, 9).toString('base64')
    fs.writeFileSync(vaultFile, JSON.stringify(tampered))
    const tamperedVault = new DevelopmentWorkerCredentialVault({
      ...options,
      dataRoot: backupRoot
    })
    await assert.rejects(
      tamperedVault.restore([{
        id: 'account-vault',
        credential_version: 1,
        access_token: 'stale',
        refresh_token: 'stale'
      }]),
      /authentication/
    )
    assert.throws(() => loadWorkerCredentialVault({
      environment: 'production',
      ...options
    }), /KMS\/Secret Manager/)
    assert.ok(loadWorkerCredentialVault({
      environment: 'preproduction',
      ...options
    }) instanceof DevelopmentWorkerCredentialVault)
  })

  it('syncs the pool, rotates cooled accounts, preserves tool IDs and reports usage', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-chatgpt-'))
    temporaryDirectories.add(dataRoot)
    const upstreamCalls = []
    const refreshCalls = []
    let firstAccountFailureStatus = 429
    const fetchImpl = async (url, options = {}) => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        const body = JSON.parse(options.body)
        refreshCalls.push(body.refresh_token)
        return new Response(JSON.stringify({
          access_token: 'access-second-refreshed',
          refresh_token: 'refresh-second-rotated'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      upstreamCalls.push({
        url: String(url),
        authorization: options.headers?.authorization,
        body: options.body ? JSON.parse(options.body) : null
      })
      if (String(options.headers?.authorization || '').includes('access-first')) {
        return new Response(JSON.stringify({
          error: firstAccountFailureStatus === 429
            ? { code: 'usage_limit', message: 'account quota reached' }
            : { code: 'invalid_token', message: 'account login expired' }
        }), {
          status: firstAccountFailureStatus,
          headers: {
            'content-type': 'application/json',
            ...(firstAccountFailureStatus === 429 ? { 'retry-after': '60' } : {})
          }
        })
      }
      const payload = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_worker_ok","call_id":"tool_original","name":"demo","arguments":"{}"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SUB_POOL_OK"}]}],"usage":{"input_tokens":11,"output_tokens":4}}}',
        '',
        ''
      ].join('\n')
      return new Response(payload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    }
    const credentialVault = new DevelopmentWorkerCredentialVault({
      dataRoot,
      workerId: 'worker-local',
      region: 'local-development'
    })
    const executor = new ChatgptSubscriptionExecutor({
      dataRoot,
      environment: 'test',
      fetchImpl,
      credentialVault
    })
    const { origin } = await startWorker({ executor })
    const configuration = {
      schemaVersion: 1,
      provider: 'chatgpt-sub',
      enabled: true,
      experimental: true,
      responsesUrl: 'https://chatgpt.example/backend-api/codex/responses',
      accountStrategy: 'priority',
      modelIds: ['gpt-5.6-sol'],
      accounts: [{
        id: 'account-first',
        label: 'First',
        account_id: 'upstream-first',
        access_token: 'access-first',
        refresh_token: 'refresh-first',
        expires_at: Date.now() + 60 * 60_000,
        routing_enabled: true,
        routing_weight: 1,
        low_quota_threshold: 10,
        credential_version: 1,
        status: 'active'
      }, {
        id: 'account-second',
        label: 'Second',
        account_id: 'upstream-second',
        access_token: 'access-second',
        refresh_token: 'refresh-second',
        expires_at: Date.now() - 60_000,
        routing_enabled: true,
        routing_weight: 1,
        low_quota_threshold: 10,
        credential_version: 1,
        status: 'active'
      }]
    }
    const configure = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub',
      { method: 'PUT', body: configuration }
    )
    const configured = await configure.fetch()
    configure.body.fill(0)
    assert.equal(configured.status, 200)
    assert.deepEqual(await configured.json(), {
      schemaVersion: 1,
      provider: 'chatgpt-sub',
      executor: 'chatgpt-sub',
      enabled: true,
      accountCount: 2,
      routableAccountCount: 2,
      modelCount: 1,
      experimental: true
    })

    const modelsRequest = signedRequest(origin, '/internal/v1/models')
    const models = await modelsRequest.fetch()
    modelsRequest.body.fill(0)
    assert.deepEqual(
      (await models.json()).data.map(model => model.id),
      ['gpt-5.6-sol']
    )

    const turnId = 'turn_chatgpt_pool_rotation'
    const execute = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId,
      body: {
        model: 'gpt-5.6-sol',
        stream: true,
        input: [{
          type: 'function_call',
          id: 'tool_mrrmem914mxsqfk7',
          call_id: 'tool_mrrmem914mxsqfk7',
          name: 'demo',
          arguments: '{}'
        }]
      }
    })
    const response = await execute.fetch()
    execute.body.fill(0)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-ai-editor-provider-id'), 'chatgpt-sub')
    assert.match(await response.text(), /SUB_POOL_OK/)
    assert.equal(upstreamCalls.length, 2)
    assert.equal(upstreamCalls[0].authorization, 'Bearer access-first')
    assert.equal(upstreamCalls[1].authorization, 'Bearer access-second-refreshed')
    assert.deepEqual(refreshCalls, ['refresh-second'])
    assert.match(upstreamCalls[0].body.input[0].id, /^fc_/)
    assert.equal(
      upstreamCalls[0].body.input[0].call_id,
      'tool_mrrmem914mxsqfk7'
    )
    const restoredAfterRefresh = await new DevelopmentWorkerCredentialVault({
      dataRoot,
      workerId: 'worker-local',
      region: 'local-development'
    }).restore(configuration.accounts)
    assert.equal(
      restoredAfterRefresh[1].refresh_token,
      'refresh-second-rotated'
    )

    const poolRequest = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub/accounts'
    )
    const poolResponse = await poolRequest.fetch()
    poolRequest.body.fill(0)
    assert.equal(poolResponse.status, 200)
    const pool = await poolResponse.json()
    assert.equal(pool.accounts[0].status, 'cooldown')
    assert.ok(pool.accounts[0].runtime.cooldownUntil > Date.now())
    assert.equal(pool.accounts[1].status, 'active')
    assert.equal(pool.recentRouteDecisions[0].selectedAccountId, 'account-second')

    const statusRequest = signedRequest(
      origin,
      `/internal/v1/turns/${turnId}`,
      { turnId }
    )
    const statusResponse = await statusRequest.fetch()
    statusRequest.body.fill(0)
    const status = await statusResponse.json()
    assert.deepEqual(status.usage, { inputTokens: 11, outputTokens: 4 })

    firstAccountFailureStatus = 401
    const authenticationConfiguration = structuredClone(configuration)
    authenticationConfiguration.accounts[0].access_token = 'access-first-v2'
    authenticationConfiguration.accounts[0].refresh_token = 'refresh-first-v2'
    authenticationConfiguration.accounts[0].credential_version = 2
    authenticationConfiguration.accounts[1].access_token = 'access-second-v2'
    authenticationConfiguration.accounts[1].refresh_token = 'refresh-second-v2'
    authenticationConfiguration.accounts[1].credential_version = 2
    authenticationConfiguration.accounts[1].expires_at = Date.now() + 60 * 60_000
    const reconfigure = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub',
      { method: 'PUT', body: authenticationConfiguration }
    )
    assert.equal((await reconfigure.fetch()).status, 200)
    reconfigure.body.fill(0)
    const authenticationTurn = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId: 'turn_chatgpt_auth_rotation',
      body: {
        model: 'gpt-5.6-sol',
        stream: true,
        input: 'authentication rotation'
      }
    })
    const authenticationResponse = await authenticationTurn.fetch()
    assert.equal(authenticationResponse.status, 200)
    await authenticationResponse.text()
    authenticationTurn.body.fill(0)
    assert.deepEqual(
      upstreamCalls.slice(2, 4).map(call => call.authorization),
      ['Bearer access-first-v2', 'Bearer access-second-v2']
    )
    const authPoolRequest = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub/accounts'
    )
    const authPoolResponse = await authPoolRequest.fetch()
    authPoolRequest.body.fill(0)
    const authPool = await authPoolResponse.json()
    assert.equal(authPool.accounts[0].status, 'auth_error')

    const routingConfiguration = structuredClone(authenticationConfiguration)
    routingConfiguration.accounts[0].access_token = 'access-first-v3'
    routingConfiguration.accounts[0].refresh_token = 'refresh-first-v3'
    routingConfiguration.accounts[0].credential_version = 3
    routingConfiguration.accounts[0].routing_enabled = false
    routingConfiguration.accounts[1].access_token = 'access-second-v3'
    routingConfiguration.accounts[1].refresh_token = 'refresh-second-v3'
    routingConfiguration.accounts[1].credential_version = 3
    const routingConfigure = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub',
      { method: 'PUT', body: routingConfiguration }
    )
    assert.equal((await routingConfigure.fetch()).status, 200)
    routingConfigure.body.fill(0)
    const routingTurn = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId: 'turn_chatgpt_routing_disabled',
      body: {
        model: 'gpt-5.6-sol',
        stream: true,
        input: 'routing participation'
      }
    })
    const routingResponse = await routingTurn.fetch()
    assert.equal(routingResponse.status, 200)
    await routingResponse.text()
    routingTurn.body.fill(0)
    assert.equal(upstreamCalls.at(-1).authorization, 'Bearer access-second-v3')
    assert.equal(
      upstreamCalls.some(call => call.authorization === 'Bearer access-first-v3'),
      false
    )
    assert.equal(fs.existsSync(path.join(dataRoot, 'codex-proxy-config.json')), false)
    const storedText = fs.readdirSync(dataRoot, {
      recursive: true,
      withFileTypes: true
    })
      .filter(entry => entry.isFile())
      .map(entry => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n')
    for (const secret of [
      'access-first',
      'refresh-first',
      'access-second',
      'refresh-second'
    ]) {
      assert.equal(storedText.includes(secret), false)
    }
  })

  it('requires administrator reauthentication when every enabled subscription account has an auth error', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-relogin-'))
    temporaryDirectories.add(dataRoot)
    const executor = new ChatgptSubscriptionExecutor({
      dataRoot,
      environment: 'test',
      fetchImpl: async () => {
        throw new Error('An auth-error pool must not call the upstream')
      }
    })
    const { origin } = await startWorker({ executor })
    const configuration = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub',
      {
        method: 'PUT',
        body: {
          schemaVersion: 1,
          provider: 'chatgpt-sub',
          enabled: true,
          experimental: true,
          responsesUrl: 'https://chatgpt.example/backend-api/codex/responses',
          accountStrategy: 'priority',
          modelIds: ['gpt-5.6-sol'],
          accounts: [{
            id: 'account-relogin',
            label: 'Relogin required',
            account_id: 'upstream-relogin',
            access_token: 'expired-access',
            refresh_token: 'revoked-refresh',
            expires_at: Date.now() + 60 * 60_000,
            routing_enabled: true,
            credential_version: 1,
            status: 'auth_error'
          }]
        }
      }
    )
    assert.equal((await configuration.fetch()).status, 200)
    configuration.body.fill(0)

    const execute = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId: 'turn_chatgpt_relogin_required',
      body: {
        model: 'gpt-5.6-sol',
        stream: true,
        input: 'hello'
      }
    })
    const response = await execute.fetch()
    execute.body.fill(0)
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'worker_provider_relogin_required',
        message: 'ChatGPT subscription account requires administrator reauthentication',
        requestId: response.headers.get('x-request-id'),
        retryable: false
      }
    })
  })

  it('normalizes a permanently rejected refresh token to the relogin-required error', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-refresh-invalid-'))
    temporaryDirectories.add(dataRoot)
    const executor = new ChatgptSubscriptionExecutor({
      dataRoot,
      environment: 'test',
      fetchImpl: async url => {
        assert.equal(String(url), 'https://auth.openai.com/oauth/token')
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token revoked'
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    const { origin } = await startWorker({ executor })
    const configuration = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub',
      {
        method: 'PUT',
        body: {
          schemaVersion: 1,
          provider: 'chatgpt-sub',
          enabled: true,
          experimental: true,
          responsesUrl: 'https://chatgpt.example/backend-api/codex/responses',
          accountStrategy: 'priority',
          modelIds: ['gpt-5.6-sol'],
          accounts: [{
            id: 'account-refresh-invalid',
            label: 'Refresh invalid',
            account_id: 'upstream-refresh-invalid',
            access_token: 'expired-access',
            refresh_token: 'revoked-refresh',
            expires_at: Date.now() - 60_000,
            routing_enabled: true,
            credential_version: 1,
            status: 'active'
          }]
        }
      }
    )
    assert.equal((await configuration.fetch()).status, 200)
    configuration.body.fill(0)

    const execute = signedRequest(origin, '/internal/v1/responses', {
      method: 'POST',
      turnId: 'turn_chatgpt_refresh_invalid',
      body: {
        model: 'gpt-5.6-sol',
        stream: true,
        input: 'hello'
      }
    })
    const response = await execute.fetch()
    execute.body.fill(0)
    assert.equal(response.status, 409)
    const error = await response.json()
    assert.equal(error.error.code, 'worker_provider_relogin_required')
    assert.equal(error.error.retryable, false)

    const poolRequest = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub/accounts'
    )
    const poolResponse = await poolRequest.fetch()
    poolRequest.body.fill(0)
    assert.equal(poolResponse.status, 200)
    const pool = await poolResponse.json()
    assert.equal(pool.accounts[0].status, 'auth_error')
    assert.equal(pool.accounts[0].health.lastErrorType, 'token_refresh')
  })

  it('normalizes a manual usage refresh with a rejected token to relogin-required', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-usage-invalid-'))
    temporaryDirectories.add(dataRoot)
    const executor = new ChatgptSubscriptionExecutor({
      dataRoot,
      environment: 'test',
      fetchImpl: async url => {
        assert.equal(String(url), 'https://auth.openai.com/oauth/token')
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token revoked'
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    const { origin } = await startWorker({ executor })
    const configuration = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub',
      {
        method: 'PUT',
        body: {
          schemaVersion: 1,
          provider: 'chatgpt-sub',
          enabled: true,
          experimental: true,
          responsesUrl: 'https://chatgpt.example/backend-api/codex/responses',
          accountStrategy: 'priority',
          modelIds: ['gpt-5.6-sol'],
          accounts: [{
            id: 'account-usage-invalid',
            label: 'Usage refresh invalid',
            account_id: 'upstream-usage-invalid',
            access_token: 'expired-access',
            refresh_token: 'revoked-refresh',
            expires_at: Date.now() - 60_000,
            routing_enabled: true,
            credential_version: 1,
            status: 'active'
          }]
        }
      }
    )
    assert.equal((await configuration.fetch()).status, 200)
    configuration.body.fill(0)

    const refreshUsage = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub/accounts/account-usage-invalid/refresh-usage',
      {
        method: 'POST',
        body: {}
      }
    )
    const refreshUsageResponse = await refreshUsage.fetch()
    refreshUsage.body.fill(0)
    assert.equal(refreshUsageResponse.status, 409)
    const refreshUsageError = await refreshUsageResponse.json()
    assert.equal(
      refreshUsageError.error.code,
      'worker_provider_relogin_required'
    )
    assert.equal(refreshUsageError.error.retryable, false)

    const poolRequest = signedRequest(
      origin,
      '/internal/v1/runtime/chatgpt-sub/accounts'
    )
    const poolResponse = await poolRequest.fetch()
    poolRequest.body.fill(0)
    assert.equal(poolResponse.status, 200)
    const pool = await poolResponse.json()
    assert.equal(pool.accounts[0].status, 'auth_error')
    assert.equal(pool.accounts[0].quota.syncStatus, 'error')
  })
})

describe('Provider Worker Turn store', () => {
  it('marks an interrupted persisted execution for manual recovery instead of rerunning it', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-interrupted-'))
    temporaryDirectories.add(dataRoot)
    const first = new ExecutionStore({
      dataRoot,
      signingSecret: SIGNING_SECRET,
      workerId: 'worker-local',
      region: 'local-development',
      now: () => 1_000
    })
    assert.equal(
      first.begin('turn-interrupted', sha256Hex(Buffer.from('request'))).state,
      'started'
    )
    const recovered = new ExecutionStore({
      dataRoot,
      signingSecret: SIGNING_SECRET,
      workerId: 'worker-local',
      region: 'local-development',
      now: () => 2_000
    })
    assert.equal(recovered.get('turn-interrupted').state, 'recovery_required')
    assert.equal(
      recovered.get('turn-interrupted').errorCode,
      'worker_restarted_before_completion'
    )
  })

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
