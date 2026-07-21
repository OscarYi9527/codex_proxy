import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  digestClientApiKey,
  loadRk3588RelayConfig
} from '../src/rk3588/relay-config.js'
import { createRk3588RelayServer } from '../src/rk3588/relay-server.js'

const roots = []
const servers = []

function credential(label) {
  return `${label}-${'x'.repeat(48)}`
}

function writeCredential(root, name, value) {
  const file = path.join(root, name)
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  return file
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  return server.address().port
}

function request(port, method, route, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined
      ? null
      : Buffer.from(
          typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body),
          'utf8'
        )
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      headers: {
        host: options.host || 'rk3588.test',
        ...(payload ? {
          'content-type': options.contentType || 'application/json',
          'content-length': String(payload.length)
        } : {}),
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
        ...options.headers
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
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('RK3588 hardened relay configuration', () => {
  it('loads file credentials, private hosts, capacity, and an HTTPS Japan origin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rk3588-config-'))
    roots.push(root)
    const client = credential('client')
    const upstream = credential('upstream')
    const config = loadRk3588RelayConfig({
      NODE_ENV: 'production',
      RK3588_CLIENT_API_KEY_FILE: writeCredential(root, 'client.key', client),
      RK3588_UPSTREAM_API_KEY_FILE: writeCredential(root, 'upstream.key', upstream),
      RK3588_UPSTREAM_ORIGIN: 'https://jp-relay.example.test',
      RK3588_ALLOWED_HOSTS: 'rk3588.example.ts.net',
      RK3588_MAX_IN_FLIGHT: '12'
    })

    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 47930)
    assert.equal(config.upstreamOrigin, 'https://jp-relay.example.test')
    assert.equal(config.maxInFlight, 12)
    assert.ok(config.allowedHosts.includes('rk3588.example.ts.net'))
    assert.equal(config.clientApiKeyDigest, digestClientApiKey(client))
    assert.equal(config.upstreamApiKey, upstream)
    assert.doesNotMatch(JSON.stringify(config), /client-|upstream-/)
  })

  it('fails closed for disabled TLS, public binding, insecure upstream, and weak files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rk3588-invalid-'))
    roots.push(root)
    const env = {
      RK3588_CLIENT_API_KEY_FILE: writeCredential(
        root,
        'client.key',
        credential('client')
      ),
      RK3588_UPSTREAM_API_KEY_FILE: writeCredential(
        root,
        'upstream.key',
        credential('upstream')
      ),
      RK3588_UPSTREAM_ORIGIN: 'https://jp-relay.example.test'
    }
    assert.throws(() => loadRk3588RelayConfig({
      ...env,
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    }), /TLS certificate verification is disabled/)
    assert.throws(() => loadRk3588RelayConfig({
      ...env,
      RK3588_RELAY_HOST: '0.0.0.0'
    }), /127\.0\.0\.1/)
    assert.throws(() => loadRk3588RelayConfig({
      ...env,
      RK3588_UPSTREAM_ORIGIN: 'http://jp-relay.example.test'
    }), /HTTPS origin/)
    if (process.platform !== 'win32') {
      const exposed = writeCredential(root, 'exposed.key', credential('exposed'))
      fs.chmodSync(exposed, 0o644)
      assert.throws(() => loadRk3588RelayConfig({
        ...env,
        RK3588_CLIENT_API_KEY_FILE: exposed
      }), /group\/other/)
    }
  })
})

describe('RK3588 private ingress to Japan upstream relay', () => {
  it('authenticates clients, replaces credentials, and preserves Responses streams', async () => {
    const clientApiKey = credential('client')
    const upstreamApiKey = credential('upstream')
    const received = []
    const upstream = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({
        method: req.method,
        route: req.url,
        authorization: req.headers.authorization,
        requestId: req.headers['x-rk3588-request-id'],
        body: Buffer.concat(chunks).toString('utf8')
      })
      if (req.url === '/v1/models') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'jp_request_safe'
        })
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'codex-jp-test', object: 'model' }]
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: response.output_text.delta\n')
      res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n')
      res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
    })
    const upstreamPort = await listen(upstream)
    const relay = createRk3588RelayServer({
      config: {
        host: '127.0.0.1',
        port: 47930,
        allowedHosts: ['rk3588.test'],
        clientApiKeyDigest: digestClientApiKey(clientApiKey),
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        upstreamApiKey,
        bodyLimitBytes: 1024 * 1024,
        maxInFlight: 2,
        upstreamTimeoutMs: 5_000
      }
    })
    const relayPort = await listen(relay.server)

    const live = await request(relayPort, 'GET', '/live')
    assert.equal(live.status, 200)
    assert.equal(JSON.parse(live.body).mode, 'rk3588')

    const unauthenticated = await request(relayPort, 'GET', '/v1/models')
    assert.equal(unauthenticated.status, 401)
    assert.match(unauthenticated.headers['www-authenticate'], /Bearer/)
    assert.equal(received.length, 0)

    const wrongHost = await request(relayPort, 'GET', '/v1/models', {
      host: 'public.example.test',
      apiKey: clientApiKey
    })
    assert.equal(wrongHost.status, 403)
    assert.equal(received.length, 0)

    const models = await request(relayPort, 'GET', '/v1/models', {
      apiKey: clientApiKey
    })
    assert.equal(models.status, 200)
    assert.equal(JSON.parse(models.body).data[0].id, 'codex-jp-test')
    assert.equal(models.headers['x-request-id'], 'jp_request_safe')

    const stream = await request(relayPort, 'POST', '/v1/responses', {
      apiKey: clientApiKey,
      headers: { 'x-ai-editor-turn-id': 'turn_test_12345678' },
      body: {
        model: 'codex-jp-test',
        input: 'hello',
        stream: true
      }
    })
    assert.equal(stream.status, 200)
    assert.match(stream.headers['content-type'], /text\/event-stream/)
    assert.match(stream.body, /response\.output_text\.delta/)
    assert.match(stream.body, /response\.completed/)
    assert.equal(received.length, 2)
    assert.ok(received.every(item =>
      item.authorization === `Bearer ${upstreamApiKey}`
    ))
    assert.ok(received.every(item =>
      typeof item.requestId === 'string' &&
      item.requestId.startsWith('rkreq_')
    ))
    assert.doesNotMatch(JSON.stringify(received), new RegExp(clientApiKey))

    const invalid = await request(relayPort, 'POST', '/v1/responses', {
      apiKey: clientApiKey,
      body: '{not-json'
    })
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body).error.code, 'invalid_json')
    assert.equal(received.length, 2)
  })

  it('enforces bounded concurrency without retrying accepted POST requests', async () => {
    const clientApiKey = credential('client')
    let release
    let signalStarted
    const started = new Promise(resolve => { signalStarted = resolve })
    const gate = new Promise(resolve => { release = resolve })
    let calls = 0
    const upstream = http.createServer(async (_req, res) => {
      calls += 1
      signalStarted()
      await gate
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"id":"response_once"}')
    })
    const upstreamPort = await listen(upstream)
    const relay = createRk3588RelayServer({
      config: {
        host: '127.0.0.1',
        port: 47930,
        allowedHosts: ['rk3588.test'],
        clientApiKeyDigest: digestClientApiKey(clientApiKey),
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        upstreamApiKey: credential('upstream'),
        bodyLimitBytes: 1024 * 1024,
        maxInFlight: 1,
        upstreamTimeoutMs: 5_000
      }
    })
    const relayPort = await listen(relay.server)

    const first = request(relayPort, 'POST', '/v1/responses', {
      apiKey: clientApiKey,
      body: { model: 'codex-jp-test', input: 'first' }
    })
    await started
    const busy = await request(relayPort, 'POST', '/v1/responses', {
      apiKey: clientApiKey,
      body: { model: 'codex-jp-test', input: 'second' }
    })
    assert.equal(busy.status, 503)
    assert.equal(JSON.parse(busy.body).error.code, 'relay_busy')
    assert.equal(busy.headers['retry-after'], '1')
    assert.equal(calls, 1)

    release()
    assert.equal((await first).status, 200)
    assert.equal(calls, 1)
  })

  it('returns a safe 504 when the Japan upstream exceeds its deadline', async () => {
    const clientApiKey = credential('client')
    let calls = 0
    const upstream = http.createServer(() => {
      calls += 1
    })
    const upstreamPort = await listen(upstream)
    const relay = createRk3588RelayServer({
      config: {
        host: '127.0.0.1',
        port: 47930,
        allowedHosts: ['rk3588.test'],
        clientApiKeyDigest: digestClientApiKey(clientApiKey),
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        upstreamApiKey: credential('upstream'),
        bodyLimitBytes: 1024 * 1024,
        maxInFlight: 1,
        upstreamTimeoutMs: 50
      }
    })
    const relayPort = await listen(relay.server)

    const response = await request(relayPort, 'POST', '/v1/responses', {
      apiKey: clientApiKey,
      body: { model: 'codex-jp-test', input: 'timeout' }
    })
    assert.equal(response.status, 504)
    assert.deepEqual(JSON.parse(response.body).error, {
      code: 'upstream_timeout',
      message: 'The Japan upstream did not complete in time.',
      retryable: true
    })
    assert.equal(calls, 1)
  })

  it('runs the complete colleague -> RK3588 -> Japan -> Codex chain', async () => {
    const colleagueKey = credential('colleague')
    const rkToJapanKey = credential('rk-jp')
    const japanToCodexKey = credential('jp-codex')
    let codexCalls = 0
    const codex = http.createServer(async (req, res) => {
      codexCalls += 1
      assert.equal(req.url, '/v1/responses')
      assert.equal(req.headers.authorization, `Bearer ${japanToCodexKey}`)
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      assert.equal(
        JSON.parse(Buffer.concat(chunks).toString('utf8')).input,
        'through-japan'
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"id":"codex_chain_ok","status":"completed"}')
    })
    const codexPort = await listen(codex)

    const japanAllowedHosts = []
    const japan = createRk3588RelayServer({
      config: {
        host: '127.0.0.1',
        port: 47931,
        allowedHosts: japanAllowedHosts,
        clientApiKeyDigest: digestClientApiKey(rkToJapanKey),
        upstreamOrigin: `http://127.0.0.1:${codexPort}`,
        upstreamApiKey: japanToCodexKey,
        bodyLimitBytes: 1024 * 1024,
        maxInFlight: 4,
        upstreamTimeoutMs: 5_000
      }
    })
    const japanPort = await listen(japan.server)
    japanAllowedHosts.push(`127.0.0.1:${japanPort}`)

    const rk = createRk3588RelayServer({
      config: {
        host: '127.0.0.1',
        port: 47930,
        allowedHosts: ['rk3588.test'],
        clientApiKeyDigest: digestClientApiKey(colleagueKey),
        upstreamOrigin: `http://127.0.0.1:${japanPort}`,
        upstreamApiKey: rkToJapanKey,
        bodyLimitBytes: 1024 * 1024,
        maxInFlight: 4,
        upstreamTimeoutMs: 5_000
      }
    })
    const rkPort = await listen(rk.server)

    const response = await request(rkPort, 'POST', '/v1/responses', {
      apiKey: colleagueKey,
      body: {
        model: 'codex-jp-test',
        input: 'through-japan'
      }
    })
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).id, 'codex_chain_ok')
    assert.equal(codexCalls, 1)
  })
})
