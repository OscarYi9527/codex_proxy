// Shared server utilities
// Used by the main server and all route handlers

import { assertCircuitAvailable, recordCircuitResult } from './circuit-breaker.js'
import { recordProviderOutcome } from './provider-health.js'
import { attachHttpErrorGuide } from './error-guide.js'

const DEFAULT_MAX_BODY_MIB = 64
const DEFAULT_BODY_TIMEOUT_MS = 60_000

function boundedPositiveNumber(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

const MAX_BODY_BYTES = Math.floor(
  boundedPositiveNumber(process.env.CODEX_PROXY_MAX_BODY_MIB, DEFAULT_MAX_BODY_MIB, 256) *
  1024 *
  1024
)
const BODY_TIMEOUT_MS = Math.floor(
  boundedPositiveNumber(process.env.CODEX_PROXY_BODY_TIMEOUT_MS, DEFAULT_BODY_TIMEOUT_MS, 300_000)
)

export function id(prefix = 'resp') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function setProxyMeta(res, fields = {}) {
  res.proxyMeta = { ...(res.proxyMeta || {}), ...fields }
}

export function proxyMetaHeaders(res, extra = {}) {
  const meta = { ...(res.proxyMeta || {}), ...extra }
  const startedAt = Number(meta.startedAt) || Date.now()
  const headers = {
    'x-codex-proxy-request-id': String(meta.requestId || ''),
    'x-codex-proxy-latency-ms': String(Math.max(0, Date.now() - startedAt))
  }
  if (meta.provider) headers['x-codex-proxy-provider'] = String(meta.provider)
  if (meta.accountId) headers['x-codex-proxy-account'] = String(meta.accountId)
  if (meta.model) headers['x-codex-proxy-model'] = String(meta.model)
  if (Number(meta.fallbackAttempts) > 0) {
    headers['x-codex-proxy-fallback-attempts'] = String(Math.floor(Number(meta.fallbackAttempts)))
  }
  if (Number(meta.queueWaitMs) > 0) {
    headers['x-codex-proxy-queue-wait-ms'] = String(Math.floor(Number(meta.queueWaitMs)))
  }
  if (Number(meta.queuePosition) > 1) {
    headers['x-codex-proxy-queue-position'] = String(Math.floor(Number(meta.queuePosition)))
  }
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value))
}

export function sendJson(res, status, data, headers = {}) {
  const text = JSON.stringify(attachHttpErrorGuide(status, data))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...proxyMetaHeaders(res),
    ...headers
  })
  res.end(text)
}

function requestBodyError(statusCode, type, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.type = type
  error.code = type
  return error
}

// Codex sends the complete Responses history on every tool continuation. Long
// coding turns and image tool results can therefore exceed 16 MiB. Always
// drain rejected uploads so a client that is still writing can receive the
// error response instead of deadlocking on TCP backpressure.
export function readJson(req, {
  maxBodyBytes = MAX_BODY_BYTES,
  bodyTimeoutMs = BODY_TIMEOUT_MS
} = {}) {
  const limit = Math.max(1, Math.floor(Number(maxBodyBytes) || MAX_BODY_BYTES))
  const timeout = Math.max(1, Math.floor(Number(bodyTimeoutMs) || BODY_TIMEOUT_MS))
  const declaredLength = Number(req.headers?.['content-length'])

  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume?.()
    return Promise.reject(requestBodyError(
      413,
      'request_too_large',
      `Request body exceeds ${Math.ceil(limit / 1024 / 1024)} MiB`
    ))
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

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
      chunks.length = 0
      req.resume?.()
      reject(error)
    }
    const onData = chunk => {
      size += chunk.length
      if (size > limit) {
        return fail(requestBodyError(
          413,
          'request_too_large',
          `Request body exceeds ${Math.ceil(limit / 1024 / 1024)} MiB`
        ))
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
      } catch {
        reject(requestBodyError(400, 'invalid_json', 'Request body is not valid JSON'))
      }
    }
    const onError = error => fail(error)
    const onAborted = () => fail(requestBodyError(408, 'request_aborted', 'Request body upload was aborted'))
    const timer = setTimeout(
      () => fail(requestBodyError(408, 'request_timeout', `Request body upload timed out after ${timeout} ms`)),
      timeout
    )
    timer.unref?.()

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function retryAfterMs(response, now = Date.now()) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

function attemptSignal(parentSignal, timeoutMs) {
  if (!timeoutMs) return { signal: parentSignal, cleanup() {} }
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal.reason || new Error('Request aborted'))
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error(`Upstream attempt timed out after ${timeoutMs} ms`)),
    timeoutMs
  )
  timer.unref?.()
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }
}

export async function fetchWithRetry(fetchImpl, url, options, maxAttempts = 5) {
  let lastError
  const {
    circuitKey = null,
    retryStatuses = [429, 502, 503, 504],
    attemptTimeoutMs = 0,
    circuitResetTimeoutMs = undefined,
    circuitProbeStaleMs = undefined,
    circuitProbeTimeoutMs = 30_000,
    maxRetryDelayMs = 30_000,
    ...fetchOptions
  } = options || {}
  const RETRYABLE_ERRORS = [
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'fetch failed',
    'network timeout', 'Socket timeout', 'NetworkError', 'timed out', 'TimeoutError',
    'request to https://api.deepseek.com'
  ]
  function isRetryableError(err) {
    const msg = (err.message || '') + (err.cause?.message || '') + (err.code || '')
    return RETRYABLE_ERRORS.some(pat => msg.includes(pat))
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const circuit = assertCircuitAvailable(circuitKey, {
      resetTimeoutMs: circuitResetTimeoutMs,
      probeStaleMs: circuitProbeStaleMs
    })
    if (fetchOptions.signal?.aborted) throw fetchOptions.signal.reason || new Error('Request aborted')
    const effectiveAttemptTimeoutMs = circuit?.probe && circuitProbeTimeoutMs > 0
      ? (attemptTimeoutMs > 0
          ? Math.min(attemptTimeoutMs, circuitProbeTimeoutMs)
          : circuitProbeTimeoutMs)
      : attemptTimeoutMs
    const attemptAbort = attemptSignal(fetchOptions.signal, effectiveAttemptTimeoutMs)
    let retryDelayMs = Math.round(500 * Math.pow(2, attempt) * (0.85 + Math.random() * 0.3))
    let preserveSignalForResponseBody = false
    const attemptStartedAt = Date.now()
    try {
      const response = await fetchImpl(url, { ...fetchOptions, signal: attemptAbort.signal })
      recordProviderOutcome(circuitKey, {
        status: response.status,
        latencyMs: Date.now() - attemptStartedAt,
        source: 'request'
      })
      if (retryStatuses.includes(response.status) && attempt < maxAttempts - 1) {
        const body = await response.text().catch(() => '')
        await response.body?.cancel().catch(() => {})
        retryDelayMs = Math.min(maxRetryDelayMs, retryAfterMs(response) ?? retryDelayMs)
        lastError = new Error(`Upstream returned HTTP ${response.status} (attempt ${attempt + 1}/${maxAttempts}): ${body.slice(0, 200)}`)
        console.error('[codex-proxy]', lastError.message)
      } else {
        // Only the request's final outcome (after all internal retries) counts
        // toward the circuit breaker, so a request that succeeds on a retry, or
        // that exhausts retries, tallies as exactly one breaker event - not one
        // per attempt.
        recordCircuitResult(circuitKey, { status: response.status })
        // The signal must remain active while a streaming response body is
        // consumed. Its unref'ed timer cleans itself up after the deadline.
        preserveSignalForResponseBody = true
        return response
      }
    } catch (error) {
      lastError = error
      const callerAborted = fetchOptions.signal?.aborted === true
      if (error.code !== 'CIRCUIT_OPEN' && !callerAborted) {
        recordProviderOutcome(circuitKey, {
          latencyMs: Date.now() - attemptStartedAt,
          error,
          source: 'request'
        })
      }
      if (callerAborted) throw error
      if (attempt < maxAttempts - 1 && isRetryableError(error)) {
        console.error('[codex-proxy] fetch error (attempt %d/%d): %s cause=%s',
          attempt + 1, maxAttempts, error.message, error.cause?.code || error.cause?.message || '-')
      } else {
        if (error.code !== 'CIRCUIT_OPEN') recordCircuitResult(circuitKey, { error })
        throw error
      }
    } finally {
      if (!preserveSignalForResponseBody) attemptAbort.cleanup()
    }
    await delay(retryDelayMs)
  }
  throw lastError
}

// Scans back from the last `"usage":` key and walks brace depth to find its
// true matching close brace, so usage objects containing nested fields (e.g.
// output_tokens_details: {...}) parse correctly. A naive non-nesting regex
// would stop at the first inner `}` and silently fail to parse.
function extractLastUsageObject(text) {
  const key = '"usage":'
  let searchFrom = text.length
  while (true) {
    const idx = text.lastIndexOf(key, searchFrom - 1)
    if (idx === -1) return null
    let i = idx + key.length
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] === '{') {
      let depth = 0
      const start = i
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') {
          depth--
          if (depth === 0) {
            try { return JSON.parse(text.slice(start, i + 1)) } catch {}
            break
          }
        }
      }
    }
    searchFrom = idx
  }
}

export async function pipeResponsesUpstream(upstream, res, { onBody = null } = {}) {
  const headers = {}
  for (const name of ['content-type', 'cache-control', 'x-request-id', 'openai-processing-ms', 'openai-version']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  Object.assign(headers, proxyMetaHeaders(res))
  res.writeHead(upstream.status, headers)
  let bodyText = ''
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      const buf = Buffer.from(chunk)
      bodyText += buf.toString('utf8')
      res.write(buf)
    }
  }
  res.end()
  if (onBody && bodyText) {
    let usage = null
    try {
      const data = JSON.parse(bodyText)
      usage = data.usage || data.response?.usage || null
    } catch {}
    if (!usage) usage = extractLastUsageObject(bodyText)
    if (usage) onBody(usage)
  }
}
