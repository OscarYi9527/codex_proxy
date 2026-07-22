// Shared server utilities
// Used by the main server and all route handlers

import { assertCircuitAvailable, recordCircuitResult } from './circuit-breaker.js'
import { recordProviderOutcome } from './provider-health.js'
import { attachHttpErrorGuide } from './error-guide.js'
import { safeErrorText } from './logger.js'
import { scanValueSecrets } from './secret-scan.js'

const MAX_BODY_BYTES = 16 * 1024 * 1024
export const RESPONSE_USAGE_TAIL_BYTES = 64 * 1024

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
  let responseStatus = status
  let responseData = attachHttpErrorGuide(status, data)
  if (res.secretScanResponse === true) {
    const findings = scanValueSecrets(responseData, {
      source: 'standalone-admin-response',
      maxFindings: 20
    })
    if (findings.length) {
      responseStatus = 500
      responseData = {
        error: {
          type: 'secret_scan_blocked',
          message: '响应包含不允许返回的敏感字段，已阻止发送。'
        }
      }
    }
  }
  const text = JSON.stringify(responseData)
  res.writeHead(responseStatus, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...proxyMetaHeaders(res),
    ...headers
  })
  res.end(text)
}

export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 16 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
    assertCircuitAvailable(circuitKey)
    if (fetchOptions.signal?.aborted) throw fetchOptions.signal.reason || new Error('Request aborted')
    const attemptAbort = attemptSignal(fetchOptions.signal, attemptTimeoutMs)
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
        console.error('[codex-proxy]', safeErrorText(lastError))
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
          attempt + 1,
          maxAttempts,
          safeErrorText(error),
          safeErrorText(error.cause?.code || error.cause?.message || '-'))
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

class FixedTailBuffer {
  constructor(limit) {
    this.buffer = Buffer.allocUnsafe(limit)
    this.limit = limit
    this.length = 0
    this.position = 0
  }

  append(value) {
    const source = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (source.length >= this.limit) {
      source.copy(this.buffer, 0, source.length - this.limit)
      this.length = this.limit
      this.position = 0
      return
    }
    const firstLength = Math.min(source.length, this.limit - this.position)
    source.copy(this.buffer, this.position, 0, firstLength)
    if (firstLength < source.length) {
      source.copy(this.buffer, 0, firstLength)
    }
    this.position = (this.position + source.length) % this.limit
    this.length = Math.min(this.limit, this.length + source.length)
  }

  toString() {
    if (this.length === 0) return ''
    if (this.length < this.limit) return this.buffer.subarray(0, this.length).toString('utf8')
    if (this.position === 0) return this.buffer.toString('utf8')
    return Buffer.concat([
      this.buffer.subarray(this.position),
      this.buffer.subarray(0, this.position)
    ], this.limit).toString('utf8')
  }
}

function usageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.usage && typeof payload.usage === 'object') return payload.usage
  if (payload.response?.usage && typeof payload.response.usage === 'object') {
    return payload.response.usage
  }
  return null
}

function extractLastSseUsage(text) {
  let usage = null
  let dataLines = []
  const consumeEvent = () => {
    if (!dataLines.length) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    try {
      usage = usageFromPayload(JSON.parse(data)) || usage
    } catch {}
  }
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '') {
      consumeEvent()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  consumeEvent()
  return usage
}

// Scans back from the last `"usage":` key and walks brace depth to find its
// true matching close brace. Quoted braces and escaped quotes are ignored, so
// nested detail objects and string values cannot terminate the object early.
function extractLastUsageObject(text) {
  const matches = [...text.matchAll(/"usage"\s*:/g)]
  for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
    let i = matches[matchIndex].index + matches[matchIndex][0].length
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] === '{') {
      let depth = 0
      const start = i
      let inString = false
      let escaped = false
      for (; i < text.length; i++) {
        const char = text[i]
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') {
          inString = true
        } else if (char === '{') {
          depth++
        } else if (char === '}') {
          depth--
          if (depth === 0) {
            try { return JSON.parse(text.slice(start, i + 1)) } catch {}
            break
          }
        }
      }
    }
  }
  return null
}

function extractUsageFromTail(text) {
  try {
    const usage = usageFromPayload(JSON.parse(text.trim()))
    if (usage) return usage
  } catch {}
  return extractLastSseUsage(text) || extractLastUsageObject(text)
}

function responseWritable(res, state) {
  return state.open &&
    res.destroyed !== true &&
    res.writableEnded !== true &&
    res.closed !== true
}

function trackResponse(res) {
  const state = { open: true }
  const markClosed = () => { state.open = false }
  for (const event of ['close', 'error', 'finish']) res.on?.(event, markClosed)
  if (res.destroyed === true || res.writableEnded === true || res.closed === true) markClosed()
  return {
    state,
    cleanup() {
      for (const event of ['close', 'error', 'finish']) res.removeListener?.(event, markClosed)
    }
  }
}

function waitForDrainOrClose(res, state) {
  if (!responseWritable(res, state) || typeof res.once !== 'function') {
    state.open = false
    return Promise.resolve(false)
  }
  return new Promise(resolve => {
    let settled = false
    const done = writable => {
      if (settled) return
      settled = true
      res.removeListener?.('drain', onDrain)
      res.removeListener?.('close', onClosed)
      res.removeListener?.('error', onClosed)
      res.removeListener?.('finish', onClosed)
      resolve(writable)
    }
    const onDrain = () => done(responseWritable(res, state))
    const onClosed = () => {
      state.open = false
      done(false)
    }
    res.once('drain', onDrain)
    res.once('close', onClosed)
    res.once('error', onClosed)
    res.once('finish', onClosed)
    if (!responseWritable(res, state)) onClosed()
  })
}

export async function pipeResponsesUpstream(upstream, res, { onBody = null } = {}) {
  const headers = {}
  for (const name of ['content-type', 'cache-control', 'x-request-id', 'openai-processing-ms', 'openai-version']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  Object.assign(headers, proxyMetaHeaders(res))
  const downstream = trackResponse(res)
  const usageTail = onBody ? new FixedTailBuffer(RESPONSE_USAGE_TAIL_BYTES) : null
  try {
    if (responseWritable(res, downstream.state)) res.writeHead(upstream.status, headers)
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        const buf = Buffer.from(chunk)
        usageTail?.append(buf)
        if (!responseWritable(res, downstream.state)) continue
        if (res.write(buf) === false) {
          await waitForDrainOrClose(res, downstream.state)
        }
      }
    }
    if (responseWritable(res, downstream.state)) res.end()
    if (onBody && usageTail.length) {
      const usage = extractUsageFromTail(usageTail.toString())
      if (usage) await onBody(usage)
    }
  } finally {
    downstream.cleanup()
  }
}
