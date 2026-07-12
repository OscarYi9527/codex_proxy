// Shared server utilities
// Used by the main server and all route handlers

import { assertCircuitAvailable, recordCircuitResult } from './circuit-breaker.js'

const MAX_BODY_BYTES = 16 * 1024 * 1024

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
  const text = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json',
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

export async function fetchWithRetry(fetchImpl, url, options, maxAttempts = 5) {
  let lastError
  const {
    circuitKey = null,
    retryStatuses = [429, 502, 503, 504],
    ...fetchOptions
  } = options || {}
  const RETRYABLE_ERRORS = [
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'fetch failed',
    'network timeout', 'Socket timeout', 'NetworkError',
    'request to https://api.deepseek.com'
  ]
  function isRetryableError(err) {
    const msg = (err.message || '') + (err.cause?.message || '') + (err.code || '')
    return RETRYABLE_ERRORS.some(pat => msg.includes(pat))
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    assertCircuitAvailable(circuitKey)
    try {
      const response = await fetchImpl(url, fetchOptions)
      recordCircuitResult(circuitKey, { status: response.status })
      if (retryStatuses.includes(response.status) && attempt < maxAttempts - 1) {
        const body = await response.text().catch(() => '')
        await response.body?.cancel().catch(() => {})
        lastError = new Error(`Upstream returned HTTP ${response.status} (attempt ${attempt + 1}/${maxAttempts}): ${body.slice(0, 200)}`)
        console.error('[codex-proxy]', lastError.message)
      } else {
        return response
      }
    } catch (error) {
      lastError = error
      if (error.code !== 'CIRCUIT_OPEN') recordCircuitResult(circuitKey, { error })
      if (attempt < maxAttempts - 1 && isRetryableError(error)) {
        console.error('[codex-proxy] fetch error (attempt %d/%d): %s', attempt + 1, maxAttempts, error.message)
      } else {
        throw error
      }
    }
    await delay(500 * Math.pow(2, attempt))
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
