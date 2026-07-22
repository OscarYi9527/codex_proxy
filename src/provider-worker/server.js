import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { loadProviderWorkerConfig } from './config.js'
import {
  sha256Hex,
  verifyProviderWorkerRequest
} from './protocol.js'
import { NonceStore } from './nonce-store.js'
import { TurnStore } from './turn-store.js'
import { ExecutionStore } from './execution-store.js'
import { MockProviderExecutor } from './mock-executor.js'
import { ChatgptSubscriptionExecutor } from './chatgpt-sub-executor.js'
import { loadWorkerCredentialVault } from './credential-vault.js'

const DEFAULT_MAX_BODY_MIB = 64
const DEFAULT_BODY_TIMEOUT_MS = 60_000

function boundedPositiveNumber(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

const BODY_LIMIT = Math.floor(
  boundedPositiveNumber(process.env.CODEX_PROXY_MAX_BODY_MIB, DEFAULT_MAX_BODY_MIB, 256) *
  1024 *
  1024
)
const BODY_TIMEOUT_MS = Math.floor(
  boundedPositiveNumber(process.env.CODEX_PROXY_BODY_TIMEOUT_MS, DEFAULT_BODY_TIMEOUT_MS, 300_000)
)
const MAX_CACHED_RESPONSE_BYTES = 8 * 1024 * 1024
function safeError(code, message, statusCode = 500, retryable = false) {
  return Object.assign(new Error(message), { code, statusCode, retryable })
}

export function readBody(req, {
  maxBodyBytes = BODY_LIMIT,
  bodyTimeoutMs = BODY_TIMEOUT_MS
} = {}) {
  const limit = Math.max(1, Math.floor(Number(maxBodyBytes) || BODY_LIMIT))
  const timeout = Math.max(1, Math.floor(Number(bodyTimeoutMs) || BODY_TIMEOUT_MS))
  const declaredLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume()
    return Promise.reject(safeError(
      'worker_request_too_large',
      `Provider Worker request exceeds ${Math.ceil(limit / 1024 / 1024)} MiB`,
      413
    ))
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0)
      chunks.length = 0
    }
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const fail = error => {
      if (settled) return
      settled = true
      cleanup()
      clearChunks()
      req.resume()
      reject(error)
    }
    const onData = chunkValue => {
      const chunk = Buffer.from(chunkValue)
      size += chunk.length
      if (size > limit) {
        chunk.fill(0)
        return fail(safeError(
          'worker_request_too_large',
          `Provider Worker request exceeds ${Math.ceil(limit / 1024 / 1024)} MiB`,
          413
        ))
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      if (!chunks.length) return resolve(Buffer.alloc(0))
      const body = Buffer.concat(chunks, size)
      clearChunks()
      resolve(body)
    }
    const onError = error => fail(error)
    const onAborted = () => fail(safeError(
      'worker_request_aborted',
      'Provider Worker request upload was aborted',
      408
    ))
    const timer = setTimeout(
      () => fail(safeError(
        'worker_request_timeout',
        `Provider Worker request upload timed out after ${timeout} ms`,
        408
      )),
      timeout
    )
    timer.unref?.()
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

function parseJson(body) {
  if (!body.length) return {}
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object')
    }
    return value
  } catch {
    throw safeError('worker_invalid_json', 'Provider Worker request body is invalid', 400)
  }
}

function sendJson(res, statusCode, value, requestId = '', headers = {}) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    ...(requestId ? { 'x-request-id': requestId } : {}),
    ...headers
  })
  res.end(payload)
  payload.fill(0)
}

function sendSafeError(res, error, requestId) {
  const statusCode = Number(error.statusCode || error.status) || 500
  const retryAfterMs = Number(error.retryAfterMs)
  const isCircuitRecovery = error.code === 'CIRCUIT_OPEN'
  const headers = {
    ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
      : {}),
    ...(statusCode === 413 ? { connection: 'close' } : {})
  }
  sendJson(res, statusCode, {
    error: {
      code: isCircuitRecovery ? 'upstream_recovering' : (error.code || 'worker_internal_error'),
      message: statusCode >= 500
        ? 'Provider Worker is temporarily unavailable'
        : error.message,
      requestId,
      retryable: error.retryable === true || statusCode >= 500,
      ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? { retryAfterMs }
        : {})
    }
  }, requestId, headers)
}

function isLoopback(remoteAddress = '') {
  return remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress.endsWith(':127.0.0.1')
}

function validateTransport(req, config) {
  if (config.tls) {
    if (!req.socket.authorized) {
      throw safeError(
        'worker_mtls_required',
        'Provider Worker requires an authorized Gateway certificate',
        401
      )
    }
    return
  }
  if (config.environment === 'production') {
    throw safeError('worker_mtls_required', 'Production Provider Worker requires mTLS', 500)
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    throw safeError(
      'worker_loopback_required',
      'Development Provider Worker only accepts loopback requests',
      403
    )
  }
}

function publicTurn(turn, executionStore) {
  const execution = executionStore.get(turn.turnId)
  const source = execution || turn
  const usageReceipt = executionStore.receipt(execution)
  return {
    turnId: source.turnId,
    state: source.state,
    createdAt: new Date(source.createdAt).toISOString(),
    updatedAt: new Date(source.updatedAt).toISOString(),
    ...(source.executionId ? { executionId: source.executionId } : {}),
    ...(source.outboxId ? { outboxId: source.outboxId } : {}),
    ...(source.providerId ? { providerId: source.providerId } : {}),
    ...(source.usage ? { usage: source.usage } : {}),
    ...(source.errorCode ? { errorCode: source.errorCode } : {}),
    ...(usageReceipt ? { usageReceipt } : {})
  }
}

export function createProviderWorkerServer(options = {}) {
  const config = options.config || loadProviderWorkerConfig()
  const now = options.now || (() => Date.now())
  const nonceStore = options.nonceStore || new NonceStore({
    now,
    ttlMs: config.nonceTtlMs
  })
  const turnStore = options.turnStore || new TurnStore({
    now,
    ttlMs: config.turnTtlMs
  })
  const executionStore = options.executionStore || new ExecutionStore({
    now,
    dataRoot: config.dataRoot,
    signingSecret: config.signingSecret,
    workerId: config.workerId || 'worker-local',
    region: config.region || 'local-development'
  })
  const credentialVault = options.credentialVault || (
    !options.executor && config.executorMode === 'chatgpt-sub'
      ? loadWorkerCredentialVault(config)
      : null
  )
  const executor = options.executor || (
    config.executorMode === 'chatgpt-sub'
      ? new ChatgptSubscriptionExecutor({
          dataRoot: config.dataRoot,
          environment: config.environment,
          fetchImpl: options.fetchImpl,
          credentialVault
        })
      : new MockProviderExecutor()
  )

  const handler = async (req, res) => {
    let body = Buffer.alloc(0)
    let requestId = ''
    try {
      validateTransport(req, config)
      const host = req.headers.host || `${config.host}:${config.port}`
      const url = new URL(req.url, `${config.tls ? 'https' : 'http'}://${host}`)
      const requestTarget = `${url.pathname}${url.search}`

      if (req.method === 'GET' && url.pathname === '/live') {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'ai-editor-provider-worker',
          mode: 'provider-worker'
        })
      }
      if (req.method === 'GET' && url.pathname === '/ready') {
        return sendJson(res, 200, {
          status: 'ready',
          service: 'ai-editor-provider-worker',
          transport: config.tls ? 'mtls' : 'loopback-development'
        })
      }
      if (!url.pathname.startsWith('/internal/v1/')) {
        throw safeError('worker_not_found', 'Provider Worker endpoint was not found', 404)
      }

      body = await readBody(req)
      const configurationEndpoint =
        url.pathname === '/internal/v1/runtime/chatgpt-sub'
      const accountPoolEndpoint =
        url.pathname === '/internal/v1/runtime/chatgpt-sub/accounts'
      const diagnosticsEndpoint =
        url.pathname === '/internal/v1/diagnostics'
      const usageOutboxEndpoint =
        url.pathname === '/internal/v1/usage/outbox'
      const usageAcknowledgementEndpoint =
        url.pathname === '/internal/v1/usage/outbox/ack'
      const usageRefreshMatch =
        /^\/internal\/v1\/runtime\/chatgpt-sub\/accounts\/([^/]+)\/refresh-usage$/
          .exec(url.pathname)
      const allowsEmptyTurnId =
        url.pathname === '/internal/v1/models' ||
        configurationEndpoint ||
        accountPoolEndpoint ||
        diagnosticsEndpoint ||
        usageOutboxEndpoint ||
        usageAcknowledgementEndpoint ||
        Boolean(usageRefreshMatch)
      const verified = verifyProviderWorkerRequest({
        method: req.method,
        requestTarget,
        headers: req.headers,
        body,
        signingSecret: config.signingSecret,
        allowedGatewayIds: config.allowedGatewayIds,
        now,
        maxClockSkewMs: config.maxClockSkewMs,
        allowEmptyTurnId: allowsEmptyTurnId
      })
      requestId = verified.requestId
      if (!nonceStore.consume(verified.gatewayId, verified.nonce)) {
        throw safeError(
          'worker_replay_detected',
          'Provider Worker request nonce has already been used',
          409
        )
      }

      if (req.method === 'GET' && url.pathname === '/internal/v1/models') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Model catalog requests must not include a Turn ID',
            400
          )
        }
        const models = typeof executor.listModels === 'function'
          ? await executor.listModels()
          : {
              object: 'list',
              data: [{
                id: 'gpt-worker-mock',
                object: 'model',
                owned_by: 'ai-editor-provider-worker'
              }]
            }
        return sendJson(res, 200, models, requestId)
      }

      if (configurationEndpoint && req.method === 'PUT') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Runtime configuration requests must not include a Turn ID',
            400
          )
        }
        if (typeof executor.configure !== 'function') {
          throw safeError(
            'worker_runtime_not_supported',
            'Provider Worker runtime configuration is not supported',
            409
          )
        }
        const status = await executor.configure(parseJson(body))
        return sendJson(res, 200, status, requestId)
      }

      if (configurationEndpoint && req.method === 'GET') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Runtime status requests must not include a Turn ID',
            400
          )
        }
        if (typeof executor.configurationStatus !== 'function') {
          throw safeError(
            'worker_runtime_not_supported',
            'Provider Worker runtime status is not supported',
            409
          )
        }
        return sendJson(res, 200, executor.configurationStatus(), requestId)
      }

      if (accountPoolEndpoint && req.method === 'GET') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Account pool requests must not include a Turn ID',
            400
          )
        }
        if (typeof executor.safeAccountPool !== 'function') {
          throw safeError(
            'worker_runtime_not_supported',
            'Provider Worker account pool is not supported',
            409
          )
        }
        return sendJson(res, 200, await executor.safeAccountPool(), requestId)
      }

      if (diagnosticsEndpoint && req.method === 'GET') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Diagnostic requests must not include a Turn ID',
            400
          )
        }
        if (typeof executor.safeDiagnostics !== 'function') {
          throw safeError(
            'worker_runtime_not_supported',
            'Provider Worker diagnostics are not supported',
            409
          )
        }
        return sendJson(res, 200, await executor.safeDiagnostics(), requestId)
      }

      if (usageRefreshMatch && req.method === 'POST') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Usage refresh requests must not include a Turn ID',
            400
          )
        }
        if (typeof executor.refreshAccountUsage !== 'function') {
          throw safeError(
            'worker_runtime_not_supported',
            'Provider Worker usage refresh is not supported',
            409
          )
        }
        let accountId
        try {
          accountId = decodeURIComponent(usageRefreshMatch[1])
        } catch {
          throw safeError(
            'worker_provider_account_not_found',
            'ChatGPT subscription account was not found',
            404
          )
        }
        await executor.refreshAccountUsage(accountId)
        return sendJson(res, 200, { status: 'refreshed' }, requestId)
      }

      if (usageOutboxEndpoint && req.method === 'GET') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Usage outbox requests must not include a Turn ID',
            400
          )
        }
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit === null ? 100 : Number(rawLimit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw safeError(
            'worker_outbox_limit_invalid',
            'Usage outbox limit must be between 1 and 100',
            400
          )
        }
        return sendJson(res, 200, {
          schemaVersion: 1,
          workerId: config.workerId || 'worker-local',
          region: config.region || 'local-development',
          items: executionStore.pending(limit)
        }, requestId)
      }

      if (usageAcknowledgementEndpoint && req.method === 'POST') {
        if (verified.turnId) {
          throw safeError(
            'worker_turn_mismatch',
            'Settlement acknowledgements must not include a Turn ID',
            400
          )
        }
        const value = parseJson(body)
        if (value.schemaVersion !== 1) {
          throw safeError(
            'worker_settlement_ack_invalid',
            'Settlement acknowledgement schema is invalid',
            400
          )
        }
        const result = executionStore.acknowledge(
          verified.gatewayId,
          value.acknowledgements
        )
        return sendJson(res, 200, {
          schemaVersion: 1,
          ...result
        }, requestId)
      }

      const statusMatch = /^\/internal\/v1\/turns\/([^/]+)$/.exec(url.pathname)
      const cancelMatch = /^\/internal\/v1\/turns\/([^/]+)\/cancel$/.exec(url.pathname)
      if (req.method === 'GET' && statusMatch) {
        if (verified.turnId !== statusMatch[1]) {
          throw safeError('worker_turn_mismatch', 'Signed Turn ID does not match path', 400)
        }
        const turn = turnStore.get(verified.turnId) ||
          executionStore.get(verified.turnId)
        if (!turn) throw safeError('worker_turn_not_found', 'Turn was not found', 404)
        return sendJson(res, 200, publicTurn(turn, executionStore), requestId)
      }
      if (req.method === 'POST' && cancelMatch) {
        if (verified.turnId !== cancelMatch[1]) {
          throw safeError('worker_turn_mismatch', 'Signed Turn ID does not match path', 400)
        }
        const turn = turnStore.cancel(verified.turnId)
        const execution = executionStore.cancel(verified.turnId)
        const current = turn || execution
        if (!current) throw safeError('worker_turn_not_found', 'Turn was not found', 404)
        return sendJson(res, 202, publicTurn(current, executionStore), requestId)
      }

      const kind = url.pathname === '/internal/v1/responses'
        ? 'responses'
        : url.pathname === '/internal/v1/chat/completions'
          ? 'chat-completions'
          : null
      if (req.method !== 'POST' || !kind) {
        throw safeError('worker_not_found', 'Provider Worker endpoint was not found', 404)
      }
      const value = parseJson(body)
      if (typeof value.model !== 'string' || !value.model) {
        throw safeError('worker_model_required', 'Provider Worker model is required', 400)
      }
      const supported = typeof executor.supportsModel === 'function'
        ? await executor.supportsModel(value.model)
        : value.model === 'gpt-worker-mock'
      if (!supported) {
        throw safeError(
          'worker_model_unavailable',
          'Provider Worker model is not available',
          409,
          true
        )
      }
      const fingerprint = sha256Hex(Buffer.concat([
        Buffer.from(kind),
        Buffer.from([0]),
        body
      ]))
      const executionBegin = executionStore.begin(verified.turnId, fingerprint)
      if (executionBegin.state === 'conflict') {
        throw safeError(
          'worker_turn_conflict',
          'Turn ID was reused with a different request',
          409
        )
      }
      if (executionBegin.state === 'running') {
        throw safeError(
          'worker_turn_in_progress',
          'Turn is already running',
          409,
          true
        )
      }
      if (executionBegin.state === 'completed') {
        const cached = turnStore.get(verified.turnId)
        if (!cached?.response) {
          throw safeError(
            'worker_turn_completed_pending_settlement',
            'Turn completed and is awaiting Gateway reconciliation',
            409
          )
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-request-id': requestId,
          'x-ai-editor-provider-id':
            executionBegin.execution.providerId || 'provider-worker-mock',
          'x-ai-editor-execution-id': executionBegin.execution.executionId,
          'x-ai-editor-outbox-id': executionBegin.execution.outboxId,
          'x-ai-editor-idempotent-replay': 'true'
        })
        res.end(cached.response)
        return
      }
      if (executionBegin.state !== 'started') {
        throw safeError(
          'worker_turn_recovery_required',
          'Turn cannot be re-executed until its persisted state is reconciled',
          409
        )
      }
      const begin = turnStore.begin(verified.turnId, fingerprint)

      try {
        const result = await executor.execute({
          kind,
          body: value,
          turnId: verified.turnId,
          requestId,
          signal: begin.turn.abortController.signal
        })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-request-id': requestId,
          'x-ai-editor-provider-id': result.providerId,
          'x-ai-editor-execution-id': executionBegin.execution.executionId,
          'x-ai-editor-outbox-id': executionBegin.execution.outboxId
        })
        const responseChunks = []
        let responseSize = 0
        const cancelOnDisconnect = () => {
          if (!res.writableEnded) turnStore.cancel(verified.turnId)
        }
        res.once('close', cancelOnDisconnect)
        for await (const chunkValue of result.stream()) {
          const chunk = Buffer.from(chunkValue)
          responseSize += chunk.length
          if (responseSize > MAX_CACHED_RESPONSE_BYTES) {
            chunk.fill(0)
            throw safeError(
              'worker_response_too_large',
              'Provider Worker response exceeded the replay cache limit',
              502
            )
          }
          responseChunks.push(Buffer.from(chunk))
          await new Promise((resolve, reject) => {
            res.write(chunk, error => error ? reject(error) : resolve())
          })
          chunk.fill(0)
        }
        const response = Buffer.concat(responseChunks)
        for (const chunk of responseChunks) chunk.fill(0)
        executionStore.complete(verified.turnId, {
          usage: result.usage,
          providerId: result.providerId
        })
        const completed = turnStore.complete(verified.turnId, {
          response,
          usage: result.usage,
          providerId: result.providerId
        })
        response.fill(0)
        if (!completed) {
          throw safeError(
            'worker_turn_cancelled',
            'Provider Worker Turn was cancelled',
            409
          )
        }
        res.removeListener('close', cancelOnDisconnect)
        res.end()
      } catch (error) {
        turnStore.fail(verified.turnId, error.code || 'worker_provider_failed')
        executionStore.fail(verified.turnId, error.code || 'worker_provider_failed')
        if (res.headersSent && !res.writableEnded && !res.destroyed) res.end()
        throw error
      }
    } catch (error) {
      if (error?.safeDiagnostic) {
        console.warn(JSON.stringify({
          event: 'provider_worker_upstream_rejected',
          requestId,
          diagnostic: error.safeDiagnostic
        }))
      }
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        sendSafeError(res, error, requestId)
      }
    } finally {
      body.fill(0)
    }
  }

  const server = config.tls
    ? https.createServer({
        key: fs.readFileSync(config.tls.keyFile),
        cert: fs.readFileSync(config.tls.certFile),
        ca: fs.readFileSync(config.tls.caFile),
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      }, handler)
    : http.createServer(handler)

  return {
    server,
    config,
    nonceStore,
    turnStore,
    executionStore,
    executor,
    credentialVault,
    async close() {
      turnStore.close()
      if (!server.listening) return
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  }
}

export async function startProviderWorkerServer(options = {}) {
  const worker = createProviderWorkerServer(options)
  fs.mkdirSync(worker.config.dataRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(worker.config.dataRoot, '.ai-editor-provider-worker-data-root'),
    'provider-worker-development-data\n',
    { encoding: 'utf8', mode: 0o600 }
  )
  await new Promise((resolve, reject) => {
    worker.server.once('error', reject)
    worker.server.listen(worker.config.port, worker.config.host, resolve)
  })
  const scheme = worker.config.tls ? 'https' : 'http'
  console.log(
    `[ai-editor-provider-worker] listening on ${scheme}://${worker.config.host}:${worker.config.port}`
  )
  return worker
}
