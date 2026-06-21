import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'

const PORT = 47891
const PROXY_DIR = path.join(os.homedir(), '.claude', 'proxy')
const MODELS_FILE = path.join(PROXY_DIR, 'models.json')
const CURRENT_MODEL_FILE = path.join(PROXY_DIR, 'current-model.json')
const SESSIONS_DIR = path.join(PROXY_DIR, 'sessions')
const QUOTA_STATUS_FILE = path.join(PROXY_DIR, 'quota-status.json')

try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }) } catch {}

const LAST_CLEANUP_FILE = path.join(SESSIONS_DIR, '.last-cleanup')
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSION_FILES = 50000

function cleanupSessions() {
  const now = Date.now()
  try {
    const last = parseInt(fs.readFileSync(LAST_CLEANUP_FILE, 'utf8'), 10)
    // Skip if last cleanup was recent; also handles clock-skew: if last > now, force cleanup
    if (!isNaN(last) && last <= now && now - last < THIRTY_DAYS) return
  } catch {}

  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f !== '.last-cleanup')
      .map(f => {
        try { return { path: path.join(SESSIONS_DIR, f), mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs } }
        catch { return null }
      })
      .filter(Boolean)

    files.sort((a, b) => a.mtime - b.mtime)

    let toDelete
    if (files.length > MAX_SESSION_FILES) {
      // FIFO: trim oldest until at limit
      toDelete = files.slice(0, files.length - MAX_SESSION_FILES)
      console.log(`[proxy] Cleanup: FIFO removed ${toDelete.length} oldest session files (was ${files.length})`)
    } else {
      // Age-based: delete files not touched in 30 days
      const cutoff = now - THIRTY_DAYS
      toDelete = files.filter(f => f.mtime < cutoff)
      if (toDelete.length > 0) console.log(`[proxy] Cleanup: removed ${toDelete.length} session files older than 30 days`)
    }

    for (const f of toDelete) try { fs.unlinkSync(f.path) } catch {}
    fs.writeFileSync(LAST_CLEANUP_FILE, String(now))
  } catch (err) {
    console.error('[proxy] Cleanup error:', err.message)
  }
}

cleanupSessions()

// Shared read-only cache — loaded once at startup, safe across all sessions.
// models.json rarely changes; restart the proxy to pick up new entries.
let cachedModels = null

const PROVIDER_HOSTS = {
  anthropic:  { host: 'api.anthropic.com', pathPrefix: '' },
  deepseek:   { host: 'api.deepseek.com',  pathPrefix: '/anthropic' },
  'claude-ai': { host: 'api.anthropic.com', pathPrefix: '' }
}

function getQuotaStatus() {
  try { return JSON.parse(fs.readFileSync(QUOTA_STATUS_FILE, 'utf8')) } catch { return {} }
}

function isQuotaExhausted(provider) {
  const entry = getQuotaStatus()[provider]
  if (!entry || !entry.exhausted) return false
  // Use != null to guard against null/undefined exhausted_at (falsy short-circuit bug)
  // exhausted_at == null means corrupt/missing → treat as expired, auto-reset
  if (entry.exhausted_at == null || Date.now() - entry.exhausted_at > 24 * 60 * 60 * 1000) {
    const status = getQuotaStatus()
    delete status[provider]
    try { fs.writeFileSync(QUOTA_STATUS_FILE, JSON.stringify(status, null, 2)) } catch {}
    console.log(`[proxy] ${provider} quota auto-reset after 24h`)
    return false
  }
  return true
}

function markQuotaExhausted(provider) {
  const status = getQuotaStatus()
  status[provider] = { exhausted: true, exhausted_at: Date.now() }
  try { fs.writeFileSync(QUOTA_STATUS_FILE, JSON.stringify(status, null, 2)) } catch {}
  console.log(`[proxy] ${provider} quota exhausted at ${new Date().toISOString()}, fallback active`)
}

function getModels() {
  if (!cachedModels) {
    try {
      cachedModels = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')).models
    } catch {
      cachedModels = []
    }
  }
  return cachedModels
}

function getFallbackModelId() {
  try {
    return JSON.parse(fs.readFileSync(CURRENT_MODEL_FILE, 'utf8')).model
  } catch {
    return 'claude-haiku-4-5'
  }
}

function getModelConfig(modelId) {
  const models = getModels()
  return models.find(m => m.id === modelId) || null
}

function getSessionModel(sessionId) {
  if (!sessionId) return null
  try {
    const file = path.join(SESSIONS_DIR, `${sessionId}.json`)
    const model = JSON.parse(fs.readFileSync(file, 'utf8')).model
    // Touch mtime at most once per day so active sessions are never aged out by cleanup
    const now = new Date()
    const oneDayAgo = now.getTime() - 24 * 60 * 60 * 1000
    try {
      if (fs.statSync(file).mtimeMs < oneDayAgo) fs.utimesSync(file, now, now)
    } catch {}
    return model
  } catch {
    return null
  }
}

// Parse /s/{sessionId}/v1/... → { sessionId, actualUrl: /v1/... }
// Plain /v1/... → { sessionId: null, actualUrl: /v1/... }
function parseSessionUrl(url) {
  const m = url.match(/^\/s\/([^/]+)(\/v1\/.*)/)
  if (m) return { sessionId: m[1], actualUrl: m[2] }
  return { sessionId: null, actualUrl: url }
}

// Priority: per-session model > body.model > global fallback
// If resolved model's provider has exhausted quota, use model's fallback_model instead
function resolveModelId(rawBody, sessionId) {
  let modelId = null

  const sessionModel = getSessionModel(sessionId)
  if (sessionModel && getModelConfig(sessionModel)) {
    modelId = sessionModel
  } else {
    try {
      const body = JSON.parse(rawBody.toString())
      if (body.model && getModelConfig(body.model)) modelId = body.model
    } catch {}
    if (!modelId) modelId = getFallbackModelId()
  }

  const config = getModelConfig(modelId)
  if (config && config.fallback_model && isQuotaExhausted(config.provider)) {
    if (!getModelConfig(config.fallback_model)) {
      console.error(`[proxy] fallback_model "${config.fallback_model}" not found in models.json — check config`)
      return modelId
    }
    console.log(`[proxy] ${config.provider} quota exhausted, routing to fallback: ${config.fallback_model}`)
    return config.fallback_model
  }

  return modelId
}

function buildHeaders(originalHeaders, modelConfig) {
  const headers = {
    'content-type': 'application/json',
    'accept': originalHeaders['accept'] || 'application/json'
  }

  if (modelConfig.provider === 'anthropic') {
    if (originalHeaders['authorization'])     headers['authorization']     = originalHeaders['authorization']
    if (originalHeaders['x-api-key'])         headers['x-api-key']         = originalHeaders['x-api-key']
    if (originalHeaders['anthropic-version']) headers['anthropic-version'] = originalHeaders['anthropic-version']
    if (originalHeaders['anthropic-beta'])    headers['anthropic-beta']    = originalHeaders['anthropic-beta']
  } else if (modelConfig.provider === 'deepseek') {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY environment variable is not set')
    headers['x-api-key']         = process.env.DEEPSEEK_API_KEY
    headers['anthropic-version'] = originalHeaders['anthropic-version'] || '2023-06-01'
    if (originalHeaders['anthropic-beta']) headers['anthropic-beta'] = originalHeaders['anthropic-beta']
  } else if (modelConfig.provider === 'claude-ai') {
    if (!process.env.CLAUDE_SESSION_TOKEN) throw new Error('CLAUDE_SESSION_TOKEN environment variable is not set')
    headers['authorization']     = `Bearer ${process.env.CLAUDE_SESSION_TOKEN}`
    if (originalHeaders['anthropic-version']) headers['anthropic-version'] = originalHeaders['anthropic-version']
    if (originalHeaders['anthropic-beta'])    headers['anthropic-beta']    = originalHeaders['anthropic-beta']
  }

  return headers
}

function handleModelsList(res) {
  const models = getModels()
  const now = Math.floor(Date.now() / 1000)
  const data = models.map(m => ({
    type: 'model',
    id: m.id,
    display_name: m.name,
    created_at: new Date(now * 1000).toISOString()
  }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id || null, last_id: data[data.length - 1]?.id || null }))
}

function proxyRequest(req, res, rawBody, sessionId, effectiveUrl) {
  const modelId = resolveModelId(rawBody, sessionId)
  const modelConfig = getModelConfig(modelId)

  if (!modelConfig) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown model: ${modelId}` }))
    return
  }

  let bodyStr
  try {
    const body = JSON.parse(rawBody.toString())
    body.model = modelConfig.id
    bodyStr = JSON.stringify(body)
  } catch {
    bodyStr = rawBody.toString()
  }

  const providerConfig = PROVIDER_HOSTS[modelConfig.provider]
  const targetPath = providerConfig.pathPrefix + effectiveUrl
  let headers
  try {
    headers = buildHeaders(req.headers, modelConfig)
  } catch (err) {
    console.error(`[proxy] Header build error: ${err.message}`)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: err.message } }))
    return
  }
  headers['content-length'] = Buffer.byteLength(bodyStr)

  const options = {
    hostname: providerConfig.host,
    port: 443,
    path: targetPath,
    method: req.method,
    headers
  }

  const proxyReq = https.request(options, (proxyRes) => {
    // Intercept quota exhaustion from claude-ai subscription.
    // Return error without piping — no data has been sent to client yet at this point,
    // so Claude Code will retry cleanly. Next request hits fallback_model directly.
    if (proxyRes.statusCode === 429 && modelConfig.provider === 'claude-ai') {
      markQuotaExhausted('claude-ai')
      proxyRes.resume()
      if (!res.headersSent) {
        res.writeHead(529, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overload_error', message: 'Claude subscription quota exhausted. Switched to API key — please retry.' }
        }))
      }
      return
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })

  proxyReq.on('error', (err) => {
    console.error(`[proxy] Error forwarding to ${providerConfig.host}:`, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Proxy upstream error', details: err.message }))
    }
  })

  proxyReq.write(bodyStr)
  proxyReq.end()
}

const server = http.createServer((req, res) => {
  const { sessionId, actualUrl } = parseSessionUrl(req.url)

  if (req.method === 'GET' && actualUrl.replace(/\?.*$/, '').endsWith('/models')) {
    handleModelsList(res)
    return
  }

  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => proxyRequest(req, res, Buffer.concat(chunks), sessionId, actualUrl))
  req.on('error', (err) => {
    console.error('[proxy] Request error:', err.message)
    res.writeHead(400)
    res.end()
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.exit(0)
  }
  console.error('[proxy] Server error:', err)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] Claude Code proxy running on localhost:${PORT}`)
  console.error(`[proxy] Server started successfully`)
})

process.on('uncaughtException', (err) => {
  console.error('[proxy] Fatal error:', err)
  process.exit(1)
})
