import crypto from 'node:crypto'
import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  digestClientApiKey,
  loadRk3588RelayConfig
} from './relay-config.js'

const SUPPORTED_ROUTES = new Map([
  ['GET /v1/models', { body: false }],
  ['POST /v1/responses', { body: true }],
  ['POST /v1/chat/completions', { body: true }]
])

function requestId() {
  return `rkreq_${crypto.randomUUID().replaceAll('-', '')}`
}

function isLoopback(address = '') {
  return address === '127.0.0.1' ||
    address === '::1' ||
    address.endsWith(':127.0.0.1')
}

function relayError(code, message, statusCode, retryable = false) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable
  })
}

function validateIngress(req, config) {
  if (!isLoopback(req.socket?.remoteAddress)) {
    throw relayError(
      'private_ingress_required',
      'RK3588 relay only accepts a local private-network proxy.',
      403
    )
  }
  const host = String(req.headers.host || '').toLowerCase()
  if (!config.allowedHosts.includes(host)) {
    throw relayError('invalid_host', 'Host is not allowed by the RK3588 relay.', 403)
  }
}

function requireClientApiKey(req, expectedDigest) {
  const authorization = String(req.headers.authorization || '')
  const match = /^Bearer ([^\s]+)$/i.exec(authorization)
  const actual = Buffer.from(
    match ? digestClientApiKey(match[1]) : '0'.repeat(64),
    'hex'
  )
  const expected = Buffer.from(expectedDigest, 'hex')
  try {
    if (
      !match ||
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      throw relayError(
        'invalid_api_key',
        'A valid RK3588 client API key is required.',
        401
      )
    }
  } finally {
    actual.fill(0)
    expected.fill(0)
  }
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) {
        throw relayError('request_too_large', 'Request body is too large.', 413)
      }
      chunks.push(Buffer.from(chunk))
    }
    if (!chunks.length) {
      throw relayError('invalid_request', 'A JSON request body is required.', 400)
    }
    const body = Buffer.concat(chunks)
    try {
      JSON.parse(body.toString('utf8'))
    } catch {
      body.fill(0)
      throw relayError('invalid_json', 'Request body must be valid JSON.', 400)
    }
    return body
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0)
    throw error
  }
}

function responseHeaders(upstream, id) {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-rk3588-request-id': id
  }
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase()
    if (
      ['content-type', 'openai-processing-ms', 'retry-after', 'x-request-id']
        .includes(lower) ||
      lower.startsWith('x-ratelimit-')
    ) {
      headers[lower] = value
    }
  }
  return headers
}

function sendJson(res, statusCode, body, id, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-rk3588-request-id': id,
    ...extraHeaders
  })
  res.end(payload)
}

function safeTurnId(value) {
  const candidate = String(value || '')
  return /^[A-Za-z0-9._:-]{8,160}$/.test(candidate)
    ? candidate
    : `turn_${crypto.randomUUID().replaceAll('-', '')}`
}

async function forwardRequest(req, res, config, url, id) {
  const route = SUPPORTED_ROUTES.get(`${req.method} ${url.pathname}`)
  if (!route || url.search) {
    throw relayError('not_found', 'The RK3588 relay route does not exist.', 404)
  }
  if (
    route.body &&
    !String(req.headers['content-type'] || '').toLowerCase()
      .startsWith('application/json')
  ) {
    throw relayError(
      'unsupported_media_type',
      'Content-Type must be application/json.',
      415
    )
  }

  const body = route.body ? await readBody(req, config.bodyLimitBytes) : undefined
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('upstream timeout')),
    config.upstreamTimeoutMs
  )
  timeout.unref()
  const abort = () => controller.abort(new Error('client disconnected'))
  req.once('aborted', abort)
  res.once('close', () => {
    if (!res.writableFinished) abort()
  })

  try {
    const upstream = await fetch(new URL(url.pathname, config.upstreamOrigin), {
      method: req.method,
      headers: {
        accept: String(req.headers.accept || 'application/json'),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(req.headers['openai-beta']
          ? { 'openai-beta': String(req.headers['openai-beta']) }
          : {}),
        authorization: `Bearer ${config.upstreamApiKey}`,
        'user-agent': 'codex-proxy-rk3588/2.x',
        'x-rk3588-request-id': id,
        'x-ai-editor-turn-id': safeTurnId(req.headers['x-ai-editor-turn-id'])
      },
      body,
      redirect: 'error',
      signal: controller.signal
    })
    res.writeHead(upstream.status, responseHeaders(upstream, id))
    if (!upstream.body) {
      res.end()
      return
    }
    await pipeline(Readable.fromWeb(upstream.body), res, {
      signal: controller.signal
    })
  } catch (error) {
    if (res.headersSent || res.writableEnded || res.destroyed) return
    if (controller.signal.aborted) {
      throw relayError(
        'upstream_timeout',
        'The Japan upstream did not complete in time.',
        504,
        true
      )
    }
    throw relayError(
      'upstream_unavailable',
      'The Japan upstream is unavailable.',
      502,
      true
    )
  } finally {
    clearTimeout(timeout)
    req.off('aborted', abort)
    body?.fill(0)
  }
}

export function createRk3588RelayServer(options = {}) {
  const config = options.config || loadRk3588RelayConfig()
  let inFlight = 0
  const server = http.createServer(async (req, res) => {
    const id = requestId()
    try {
      validateIngress(req, config)
      const url = new URL(req.url || '/', 'http://rk3588.invalid')
      if (req.method === 'GET' && url.pathname === '/live' && !url.search) {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'codex-proxy-rk3588',
          mode: 'rk3588'
        }, id)
      }
      if (req.method === 'GET' && url.pathname === '/ready' && !url.search) {
        return sendJson(res, 200, {
          status: inFlight < config.maxInFlight ? 'ready' : 'busy',
          inFlight,
          capacity: config.maxInFlight,
          upstreamRegion: 'jp'
        }, id)
      }

      requireClientApiKey(req, config.clientApiKeyDigest)
      if (inFlight >= config.maxInFlight) {
        throw relayError(
          'relay_busy',
          'RK3588 relay concurrency is full; retry later.',
          503,
          true
        )
      }
      inFlight += 1
      try {
        await forwardRequest(req, res, config, url, id)
      } finally {
        inFlight -= 1
      }
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500
      sendJson(res, statusCode, {
        error: {
          code: typeof error?.code === 'string' ? error.code : 'internal_error',
          message: statusCode >= 500 && !error?.statusCode
            ? 'RK3588 relay is temporarily unavailable.'
            : String(error?.message || 'RK3588 relay request failed.'),
          retryable: error?.retryable === true
        }
      }, id, {
        ...(statusCode === 401
          ? { 'www-authenticate': 'Bearer realm="rk3588-relay"' }
          : {}),
        ...(statusCode === 503 ? { 'retry-after': '1' } : {})
      })
    }
  })
  server.requestTimeout = config.upstreamTimeoutMs + 5_000
  server.headersTimeout = 30_000
  server.keepAliveTimeout = 5_000
  return {
    server,
    config,
    snapshot: () => ({ inFlight, capacity: config.maxInFlight })
  }
}

export async function startRk3588RelayServer(options = {}) {
  const relay = createRk3588RelayServer(options)
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject)
    relay.server.listen(relay.config.port, relay.config.host, resolve)
  })
  console.log(
    `[rk3588-relay] listening on http://${relay.config.host}:${relay.config.port}; ` +
    'upstream region=jp'
  )

  let stopPromise
  const stop = async signal => {
    if (stopPromise) return stopPromise
    console.log(`[rk3588-relay] ${signal} received; draining requests`)
    relay.server.closeIdleConnections?.()
    stopPromise = new Promise(resolve => relay.server.close(resolve))
    return stopPromise
  }
  const onSigint = () => void stop('SIGINT')
  const onSigterm = () => void stop('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  return {
    ...relay,
    close: async () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      await stop('close')
    }
  }
}
