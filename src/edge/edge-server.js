import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { loadEdgeConfig, EDGE_ALLOWED_STATES } from './edge-config.js'
import {
  createPlatformRefreshTokenStore,
  LocalAccountBindingStore
} from './local-account-store.js'
import { LocalHandoffService } from './local-handoff.js'
import { GatewayClient } from './gateway-client.js'

const BODY_LIMIT = 16 * 1024 * 1024

function opaque(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

function secret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function isLoopback(remoteAddress = '') {
  return remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress.endsWith(':127.0.0.1')
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      for (const item of chunks) item.fill(0)
      throw Object.assign(new Error('Request body too large'), {
        statusCode: 413,
        code: 'request_too_large'
      })
    }
    chunks.push(Buffer.from(chunk))
  }
  if (!chunks.length) return {}
  const combined = Buffer.concat(chunks)
  try {
    return JSON.parse(combined.toString('utf8'))
  } finally {
    combined.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}

function sendJson(res, status, value, requestId) {
  const payload = status === 204 ? '' : JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId
  })
  res.end(payload)
}

function safeMockStatus(state, requestId) {
  if (state === 'ready') {
    return {
      state,
      checkedAt: new Date().toISOString(),
      account: { display: 'mock-user@example.com', role: 'user' },
      currentModel: 'gpt-mock',
      availableCredits: '1000.000000',
      actions: []
    }
  }
  return {
    state,
    checkedAt: new Date().toISOString(),
    errorId: opaque('err'),
    actions: state === 'login_required'
      ? ['login']
      : state === 'service_unavailable'
        ? ['retry']
        : ['openAccount'],
    requestId
  }
}

function validateLocalRequest(req, config) {
  if (!isLoopback(req.socket?.remoteAddress)) {
    throw Object.assign(new Error('Edge only accepts loopback clients'), {
      statusCode: 403,
      code: 'loopback_required'
    })
  }
  const allowedHosts = new Set([`${config.host}:${config.port}`, `localhost:${config.port}`])
  if (!allowedHosts.has(req.headers.host || '')) {
    throw Object.assign(new Error('Invalid Edge Host header'), {
      statusCode: 403,
      code: 'invalid_host'
    })
  }
  const origin = req.headers.origin
  if (origin) {
    const parsed = new URL(origin)
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || Number(parsed.port) !== config.port) {
      throw Object.assign(new Error('Invalid Edge Origin header'), {
        statusCode: 403,
        code: 'invalid_origin'
      })
    }
  }
}

function requireLocalNonce(req, config) {
  const candidate = Buffer.from(String(req.headers['x-ai-editor-local-nonce'] || ''))
  const expected = Buffer.from(config.localNonce)
  try {
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      throw Object.assign(new Error('Invalid local Edge nonce'), {
        statusCode: 401,
        code: 'local_authorization_required'
      })
    }
  } finally {
    candidate.fill(0)
    expected.fill(0)
  }
}

export function createEdgeServer(options = {}) {
  const config = options.config || loadEdgeConfig()
  const authMode = config.authMode || 'mock'
  let mockState = config.mockState
  let mockBindingVersion = 0
  const mockHandoffs = new Map()

  let bindingStore = options.bindingStore
  let gatewayClient = options.gatewayClient
  let handoff = options.handoffService
  if (authMode === 'real') {
    bindingStore ||= new LocalAccountBindingStore({
      secureStore: options.secureStore || createPlatformRefreshTokenStore({
        dataRoot: config.dataRoot,
        platform: options.platform
      }),
      now: options.now
    })
    gatewayClient ||= new GatewayClient({
      gatewayOrigin: config.gatewayOrigin,
      bindingStore,
      fetchImpl: options.fetchImpl,
      now: options.now
    })
    handoff ||= new LocalHandoffService({
      bindingStore,
      now: options.now
    })
  }

  const server = http.createServer(async (req, res) => {
    const requestId = opaque('req')
    try {
      validateLocalRequest(req, config)
      const url = new URL(req.url, `http://${req.headers.host}`)

      if (req.method === 'GET' && url.pathname === '/live') {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'ai-editor-edge',
          mode: 'edge'
        }, requestId)
      }
      if (req.method === 'GET' && url.pathname === '/ready') {
        if (authMode === 'real') await gatewayClient.initialize()
        const ready = authMode === 'mock'
          ? mockState !== 'service_unavailable'
          : Boolean(bindingStore.snapshot())
        return sendJson(res, 200, {
          status: ready ? 'ready' : 'degraded',
          service: 'ai-editor-edge'
        }, requestId)
      }
      if (url.pathname.startsWith('/ai-editor/')) requireLocalNonce(req, config)

      if (req.method === 'GET' && url.pathname === '/ai-editor/status') {
        const status = authMode === 'mock'
          ? safeMockStatus(mockState, requestId)
          : await gatewayClient.getSafeStatus()
        return sendJson(res, 200, status, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/ai-editor/status/retry') {
        const status = authMode === 'mock'
          ? safeMockStatus(mockState, requestId)
          : await gatewayClient.getSafeStatus()
        return sendJson(res, 200, status, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/ai-editor/handoff/start') {
        const body = await readJson(req)
        if (authMode === 'real') {
          return sendJson(res, 201, handoff.start(body.state), requestId)
        }
        if (typeof body.state !== 'string' || body.state.length < 8 || body.state.length > 512) {
          throw Object.assign(new Error('Invalid login state'), {
            statusCode: 400,
            code: 'invalid_login_state'
          })
        }
        const handoffId = opaque('lh')
        const nonce = secret()
        mockHandoffs.set(handoffId, {
          nonce,
          state: body.state,
          expiresAt: Date.now() + 60_000
        })
        return sendJson(res, 201, { handoffId, nonce, expiresIn: 60 }, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/ai-editor/handoff/complete') {
        const body = await readJson(req)
        if (authMode === 'real') {
          return sendJson(res, 200, await handoff.complete(body), requestId)
        }
        const grant = mockHandoffs.get(body.handoffId)
        mockHandoffs.delete(body.handoffId)
        if (!grant || grant.expiresAt < Date.now() || grant.nonce !== body.nonce || grant.state !== body.state) {
          throw Object.assign(new Error('Local handoff is invalid or expired'), {
            statusCode: 400,
            code: 'handoff_invalid'
          })
        }
        if (!body.deviceSessionId || !body.refreshToken || !body.accessToken) {
          throw Object.assign(new Error('Local handoff payload is incomplete'), {
            statusCode: 400,
            code: 'handoff_incomplete'
          })
        }
        mockBindingVersion += 1
        mockState = 'ready'
        return sendJson(res, 200, {
          status: 'completed',
          bindingVersion: mockBindingVersion
        }, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/ai-editor/webview-ticket') {
        if (authMode === 'real') {
          return sendJson(res, 200, await gatewayClient.requestWebviewTicket(), requestId)
        }
        if (mockState !== 'ready') {
          throw Object.assign(new Error('Account is not ready'), {
            statusCode: 409,
            code: mockState
          })
        }
        return sendJson(res, 200, { ticket: secret(), expiresIn: 60 }, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/ai-editor/logout') {
        if (authMode === 'real') {
          await gatewayClient.logout()
        } else {
          mockState = 'login_required'
          mockBindingVersion += 1
        }
        return sendJson(res, 204, null, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/ai-editor/mock/state') {
        if (authMode !== 'mock' || process.env.AI_EDITOR_ENABLE_MOCK_CONTROL !== 'true') {
          throw Object.assign(new Error('Mock control is disabled'), {
            statusCode: 404,
            code: 'not_found'
          })
        }
        const body = await readJson(req)
        if (!EDGE_ALLOWED_STATES.includes(body.state)) {
          throw Object.assign(new Error('Unsupported mock state'), {
            statusCode: 400,
            code: 'invalid_mock_state'
          })
        }
        mockState = body.state
        return sendJson(res, 200, safeMockStatus(mockState, requestId), requestId)
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (authMode === 'real') {
          return sendJson(res, 200, await gatewayClient.models(), requestId)
        }
        if (mockState !== 'ready') {
          return sendJson(res, 401, {
            error: {
              code: mockState,
              message: 'AI Editor 产品账号尚未就绪。',
              requestId,
              retryable: mockState === 'service_unavailable'
            }
          }, requestId)
        }
        return sendJson(res, 200, {
          object: 'list',
          data: [{ id: 'gpt-mock', object: 'model', owned_by: 'ai-editor' }]
        }, requestId)
      }
      if (
        authMode === 'real' &&
        req.method === 'POST' &&
        ['/v1/responses', '/v1/chat/completions'].includes(url.pathname)
      ) {
        const body = await readJson(req)
        await gatewayClient.forward(url.pathname, req, res, body)
        return
      }
      return sendJson(res, 404, {
        error: {
          code: 'not_found',
          message: '未找到请求的 Edge 接口。',
          requestId,
          retryable: false
        }
      }, requestId)
    } catch (error) {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      const statusCode = Number(error.statusCode) || 500
      const code = error.code || 'internal_error'
      return sendJson(res, statusCode, {
        error: {
          code,
          message: statusCode >= 500 ? 'Edge 暂时不可用。' : error.message,
          requestId,
          retryable: error.retryable === true || statusCode >= 500
        }
      }, requestId)
    }
  })

  return { server, config, authMode, bindingStore, gatewayClient }
}

export async function startEdgeServer(options = {}) {
  const edge = createEdgeServer(options)
  fs.mkdirSync(edge.config.dataRoot, { recursive: true, mode: 0o700 })
  const marker = path.join(edge.config.dataRoot, '.ai-editor-edge-data-root')
  fs.writeFileSync(marker, 'edge-development-data\n', {
    encoding: 'utf8',
    mode: 0o600
  })
  if (edge.authMode === 'real') await edge.gatewayClient.initialize()
  await new Promise((resolve, reject) => {
    edge.server.once('error', reject)
    edge.server.listen(edge.config.port, edge.config.host, resolve)
  })
  console.log(`[ai-editor-edge] listening on http://${edge.config.host}:${edge.config.port}`)
  return edge
}
