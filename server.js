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

try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }) } catch {}

// Shared read-only cache — loaded once at startup, safe across all sessions.
// models.json rarely changes; restart the proxy to pick up new entries.
let cachedModels = null

const PROVIDER_HOSTS = {
  anthropic: { host: 'api.anthropic.com', pathPrefix: '' },
  deepseek:  { host: 'api.deepseek.com',  pathPrefix: '/anthropic' }
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
    return JSON.parse(fs.readFileSync(file, 'utf8')).model
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
function resolveModelId(rawBody, sessionId) {
  const sessionModel = getSessionModel(sessionId)
  if (sessionModel && getModelConfig(sessionModel)) return sessionModel

  try {
    const body = JSON.parse(rawBody.toString())
    if (body.model && getModelConfig(body.model)) return body.model
  } catch {}
  return getFallbackModelId()
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
    headers['x-api-key']         = process.env.DEEPSEEK_API_KEY
    headers['anthropic-version'] = originalHeaders['anthropic-version'] || '2023-06-01'
    if (originalHeaders['anthropic-beta']) headers['anthropic-beta'] = originalHeaders['anthropic-beta']
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
  const headers = buildHeaders(req.headers, modelConfig)
  headers['content-length'] = Buffer.byteLength(bodyStr)

  const options = {
    hostname: providerConfig.host,
    port: 443,
    path: targetPath,
    method: req.method,
    headers
  }

  const proxyReq = https.request(options, (proxyRes) => {
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
