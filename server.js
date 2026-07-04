import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'

const PORT = 47891
const PROXY_DIR = path.join(os.homedir(), '.claude', 'proxy')
const MODELS_FILE = path.join(PROXY_DIR, 'models.json')
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json')
const CURRENT_MODEL_FILE = path.join(PROXY_DIR, 'current-model.json')
const SESSIONS_DIR = path.join(PROXY_DIR, 'sessions')
const QUOTA_STATUS_FILE = path.join(PROXY_DIR, 'quota-status.json')
const FALLBACK_ALERT_FILE = path.join(PROXY_DIR, 'fallback-alert.json')
const QUOTA_RESET_MS = 5 * 60 * 60 * 1000 // Claude.ai 5-hour rolling window (confirmed)

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
  if (entry.exhausted_at == null || Date.now() - entry.exhausted_at > QUOTA_RESET_MS) {
    const status = getQuotaStatus()
    delete status[provider]
    try { fs.writeFileSync(QUOTA_STATUS_FILE, JSON.stringify(status, null, 2)) } catch {}
    console.log(`[proxy] ${provider} quota auto-reset after 5h`)
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

  // One-shot override: auto-model skill writes {sessionId}.override.json,
  // consumed on next request then deleted. Highest priority, bypasses
  // session file so Agent tool's model param can take effect same-round.
  const overrideFile = path.join(SESSIONS_DIR, `${sessionId}.override.json`)
  try {
    const model = JSON.parse(fs.readFileSync(overrideFile, 'utf8')).model
    fs.unlinkSync(overrideFile)
    if (model && getModelConfig(model)) {
      console.log(`[proxy] auto-model override: ${model}`)
      return model
    }
  } catch {}

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

function hasAnthropicApiKey(headers) {
  return !!(headers['x-api-key'] || headers['authorization'])
}

// Parse /s/{sessionId}/v1/... → { sessionId, actualUrl: /v1/... }
// Plain /v1/... → { sessionId: null, actualUrl: /v1/... }
function parseSessionUrl(url) {
  const m = url.match(/^\/s\/([^/]+)(\/v1\/.*)/)
  if (m) return { sessionId: m[1], actualUrl: m[2] }
  return { sessionId: null, actualUrl: url }
}

// Priority: per-session model > body.model > global fallback
// If primary provider quota is exhausted, walks fallback_chain to find next viable model.
// Returns model id, or null when all chain entries are unavailable (exhausted or missing API key).
function resolveModelId(rawBody, sessionId, originalHeaders) {
  let modelId = null
  const headers = originalHeaders || {}

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
  if (!config) return modelId

  // Only enter fallback logic if this model has a fallback chain configured
  const chain = config.fallback_chain || (config.fallback_model ? [config.fallback_model] : [])
  if (!isQuotaExhausted(config.provider)) return modelId
  if (chain.length === 0) {
    console.error(`[proxy] ${config.provider} quota exhausted for ${modelId} but no fallback chain configured — returning error`)
    return null
  }

  // Primary provider exhausted — walk fallback chain
  for (const fbId of chain) {
    const fbConfig = getModelConfig(fbId)
    if (!fbConfig) {
      console.error(`[proxy] fallback chain entry "${fbId}" not found in models.json — skipping`)
      continue
    }
    if (isQuotaExhausted(fbConfig.provider)) {
      console.log(`[proxy] fallback ${fbId} (${fbConfig.provider}) also exhausted — skipping`)
      continue
    }
    if (fbConfig.provider === 'anthropic' && !hasAnthropicApiKey(headers)) {
      lastProxyError = `fallback ${fbId}: no API key in request headers`
      console.log(`[proxy] ${lastProxyError} — skipping`)
      continue
    }
    console.log(`[proxy] ${config.provider} quota exhausted, routing to fallback: ${fbId}`)
    return fbId
  }

  console.error(`[proxy] all fallback options exhausted for ${modelId} — returning error`)
  return null
}

// ── Fallback notice helpers ───────────────────────────────────────────────────

function getModelDisplayName(modelId) {
  if (!modelId) return 'Claude'
  const cfg = getModelConfig(modelId)
  if (cfg?.name) return cfg.name
  // Map api-mirror ids to display names
  const map = {
    'claude-opus-4-8': 'Claude Opus 4.8', 'claude-opus-4-8-api': 'Claude Opus 4.8',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6', 'claude-sonnet-4-6-api': 'Claude Sonnet 4.6',
    'claude-haiku-4-5': 'Claude Haiku 4.5', 'claude-haiku-4-5-api': 'Claude Haiku 4.5',
    'deepseek-v4-pro': 'DeepSeek V4 Pro'
  }
  return map[modelId] || modelId
}

function buildFallbackNotice(originalModelId, currentModelId) {
  const from = getModelDisplayName(originalModelId)
  const to = getModelDisplayName(currentModelId)
  return `\n\n---\n> ⚠️ ${from} 额度已用尽，已自动切换至 **${to}**。当前回复由 ${to} 生成。\n\n---\n\n`
}

function writeFallbackAlert(originalModelId, currentModelId) {
  const alert = {
    from: getModelDisplayName(originalModelId),
    fromId: originalModelId,
    to: getModelDisplayName(currentModelId),
    toId: currentModelId,
    at: new Date().toISOString(),
    message: `${getModelDisplayName(originalModelId)} 额度已用尽，已自动切换至 ${getModelDisplayName(currentModelId)}`
  }
  try {
    fs.writeFileSync(FALLBACK_ALERT_FILE, JSON.stringify(alert, null, 2))
  } catch (err) {
    console.error('[proxy] Failed to write fallback alert:', err.message)
  }
}

function injectNoticeIntoResponse(bodyStr, notice) {
  try {
    const body = JSON.parse(bodyStr)
    if (!body.content || !Array.isArray(body.content)) return bodyStr
    const textBlock = body.content.find(b => b.type === 'text')
    if (textBlock) {
      textBlock.text = notice + textBlock.text
    } else {
      body.content.unshift({ type: 'text', text: notice.slice(2) })
    }
    return JSON.stringify(body)
  } catch {
    return bodyStr
  }
}

function jsonToSSE(bodyStr) {
  try {
    const data = JSON.parse(bodyStr)
    const lines = []

    // message_start
    const msgStart = {
      type: 'message_start',
      message: {
        id: data.id,
        type: 'message',
        role: 'assistant',
        model: data.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: data.usage
      }
    }
    lines.push(`event: message_start`)
    lines.push(`data: ${JSON.stringify(msgStart)}`)

    // content blocks
    for (const [i, block] of (data.content || []).entries()) {
      if (block.type === 'text') {
        lines.push('')
        lines.push(`event: content_block_start`)
        lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })}`)
        lines.push('')
        lines.push(`event: content_block_delta`)
        lines.push(`data: ${JSON.stringify({ type: 'text_delta', text: block.text })}`)
        lines.push('')
        lines.push(`event: content_block_stop`)
        lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: i })}`)
      } else if (block.type === 'thinking') {
        lines.push('')
        lines.push(`event: content_block_start`)
        lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } })}`)
        lines.push('')
        lines.push(`event: content_block_delta`)
        lines.push(`data: ${JSON.stringify({ type: 'thinking_delta', thinking: block.thinking })}`)
        lines.push('')
        lines.push(`event: content_block_stop`)
        lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: i })}`)
      }
    }

    // message_delta
    lines.push('')
    lines.push(`event: message_delta`)
    lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: data.stop_reason, stop_sequence: data.stop_sequence }, usage: { output_tokens: data.usage?.output_tokens || 0 } })}`)

    // message_stop
    lines.push('')
    lines.push(`event: message_stop`)
    lines.push(`data: {}`)
    lines.push('')

    return lines.join('\n')
  } catch {
    return bodyStr
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000 // refresh proactively 5 min before expiry

async function getClaudeSessionToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
    const oauth = creds?.claudeAiOauth
    if (!oauth?.accessToken) {
      console.error('[proxy] No claudeAiOauth.accessToken found in credentials file')
      return null
    }

    const expiresAt = oauth.expiresAt
    // Refresh proactively if within margin, or if no expiry known
    if (!expiresAt || Date.now() > expiresAt - TOKEN_REFRESH_MARGIN) {
      console.log('[proxy] Claude token expired or expiring soon, attempting refresh...')
      const newToken = await refreshClaudeToken(oauth.refreshToken)
      if (newToken) return newToken
      // If still within validity window, keep using current token
      if (expiresAt && Date.now() < expiresAt) {
        console.log('[proxy] Refresh failed, using existing token (still valid, within margin)')
        return oauth.accessToken
      }
      console.error('[proxy] Token expired and refresh failed')
      return null
    }

    return oauth.accessToken
  } catch (err) {
    console.error('[proxy] Failed to read credentials file:', err.message)
    return null
  }
}

function refreshClaudeToken(refreshToken) {
  if (!refreshToken) return Promise.resolve(null)

  return new Promise((resolve) => {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })

    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params.toString())
      }
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (res.statusCode === 200 && body.access_token) {
            const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
            creds.claudeAiOauth.accessToken = body.access_token
            if (body.refresh_token) creds.claudeAiOauth.refreshToken = body.refresh_token
            if (body.expires_in) creds.claudeAiOauth.expiresAt = Date.now() + body.expires_in * 1000
            fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds))
            console.log('[proxy] Token refreshed successfully, new expiry: ' + new Date(creds.claudeAiOauth.expiresAt).toISOString())
            resolve(body.access_token)
          } else {
            console.error(`[proxy] Token refresh rejected: HTTP ${res.statusCode} — ${JSON.stringify(body).slice(0, 200)}`)
            resolve(null)
          }
        } catch (err) {
          console.error('[proxy] Token refresh parse error:', err.message)
          resolve(null)
        }
      })
    })

    req.on('error', (err) => {
      console.error('[proxy] Token refresh network error:', err.message)
      resolve(null)
    })

    req.setTimeout(15000, () => {
      req.destroy(new Error('refresh timeout'))
    })

    req.write(params.toString())
    req.end()
  })
}

async function buildHeaders(originalHeaders, modelConfig) {
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
    // Forward ALL first-party headers from Claude Code so Anthropic
    // sees the request as a legitimate subscription client (enables
    // Sonnet/Opus for Pro tier via internal billing path).
    // Fall back to credentials.json Bearer token only when the request
    // has no auth (e.g. from external API callers).
    const hasAuth = !!(originalHeaders['x-api-key'] || originalHeaders['authorization'])
    if (hasAuth) {
      if (originalHeaders['x-api-key'])         headers['x-api-key']         = originalHeaders['x-api-key']
      if (originalHeaders['authorization'])     headers['authorization']     = originalHeaders['authorization']
      if (originalHeaders['user-agent'])        headers['user-agent']        = originalHeaders['user-agent']
      if (originalHeaders['x-app'])             headers['x-app']             = originalHeaders['x-app']
      if (originalHeaders['x-claude-code-session-id']) headers['x-claude-code-session-id'] = originalHeaders['x-claude-code-session-id']
      if (originalHeaders['x-anthropic-billing-header']) headers['x-anthropic-billing-header'] = originalHeaders['x-anthropic-billing-header']
      if (originalHeaders['anthropic-client-platform']) headers['anthropic-client-platform'] = originalHeaders['anthropic-client-platform']
      if (originalHeaders['anthropic-dangerous-direct-browser-access']) headers['anthropic-dangerous-direct-browser-access'] = originalHeaders['anthropic-dangerous-direct-browser-access']
    } else {
      const token = await getClaudeSessionToken()
      if (!token) throw new Error('Claude 订阅 Token 未找到，请先登录 claude.ai (claudeAiOauth.accessToken)')
      headers['authorization'] = `Bearer ${token}`
    }
    if (originalHeaders['anthropic-version']) headers['anthropic-version'] = originalHeaders['anthropic-version']
    if (originalHeaders['anthropic-beta'])    headers['anthropic-beta']    = originalHeaders['anthropic-beta']
  }

  return headers
}

function handleModelsList(res) {
  const models = getModels()
  const now = Math.floor(Date.now() / 1000)
  const visible = models.filter(m => m.name)
  const data = visible.map(m => ({
    type: 'model',
    id: m.id,
    display_name: m.name,
    created_at: new Date(now * 1000).toISOString()
  }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id || null, last_id: data[data.length - 1]?.id || null }))
}

// Last error for debugging 529 responses
let lastProxyError = ''

// retryState: { candidates: string[], idx: number, retries: number, originalModelId: string, isStreaming: boolean } or null (first call).
// Walks [primary model, ...fallback_chain] until one succeeds.
// Skips candidates whose buildHeaders fails (missing token), and retries
// the next candidate on 429 quota exhaustion or persistent network errors.
async function proxyRequest(req, res, rawBody, sessionId, effectiveUrl, retryState) {
  let candidates, idx, retries, originalModelId, isStreaming

  if (retryState) {
    candidates = retryState.candidates
    idx = retryState.idx
    retries = retryState.retries
    originalModelId = retryState.originalModelId
    isStreaming = retryState.isStreaming
  } else {
    lastProxyError = ''
    const modelId = resolveModelId(rawBody, sessionId, req.headers)
    if (modelId === null) {
      lastProxyError = 'resolveModelId returned null (all providers quota-exhausted)'
      return sendOutOfQuota(res)
    }
    const primaryConfig = getModelConfig(modelId)
    candidates = [modelId, ...(primaryConfig?.fallback_chain || [])]
    idx = 0
    retries = 0
    originalModelId = modelId
    try { isStreaming = JSON.parse(rawBody.toString()).stream === true } catch { isStreaming = false }
  }

  if (idx >= candidates.length) {
    return sendOutOfQuota(res)
  }

  const modelId = candidates[idx]
  const modelConfig = getModelConfig(modelId)

  if (!modelConfig) {
    lastProxyError = `Unknown model in fallback chain: ${modelId}`
    console.error(`[proxy] ${lastProxyError}`)
    return proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
  }

  let bodyStr
  let bodyObj = null
  try { bodyObj = JSON.parse(rawBody.toString()) } catch {}

  if (bodyObj) {
    bodyObj.model = modelConfig.target_model || modelConfig.id
    // For fallback providers, strip streaming so we can buffer and inject notice
    if (idx > 0 && bodyObj.stream) delete bodyObj.stream
    bodyStr = JSON.stringify(bodyObj)
  } else {
    bodyStr = rawBody.toString()
  }

  const providerConfig = PROVIDER_HOSTS[modelConfig.provider]
  const targetPath = providerConfig.pathPrefix + effectiveUrl

  let headers
  try {
    headers = await buildHeaders(req.headers, modelConfig)
  } catch (err) {
    // Token missing / env not set — skip to next fallback candidate
    lastProxyError = `${modelId} (${modelConfig.provider}): ${err.message}`
    console.log(`[proxy] Skipping ${lastProxyError}`)
    return proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
  }
  headers['content-length'] = Buffer.byteLength(bodyStr)

  const options = {
    hostname: providerConfig.host,
    port: 443,
    path: targetPath,
    method: req.method,
    headers
  }

  const proxyReq = https.request(options, async (proxyRes) => {
    // On response headers: reset to body-phase timeout.
    // 60s for initial connect/headers, reset here for body streaming.
    proxyReq.setTimeout(300000)

    if (proxyRes.statusCode === 429 && modelConfig.provider === 'claude-ai') {
      const chunks429 = []
      proxyRes.on('data', c => chunks429.push(c))
      proxyRes.on('end', () => {
        const respBody = Buffer.concat(chunks429).toString()
        let isQuota = false
        try {
          const body = JSON.parse(respBody)
          const errType = body?.error?.type || ''
          // rate_limit_error = temporary throttle (per-minute), do NOT mark exhausted
          // credit_balance_too_low / quota_exceeded = true exhaustion → mark + fallback
          isQuota = errType !== 'rate_limit_error'
        } catch { isQuota = false }

        if (isQuota) {
          markQuotaExhausted('claude-ai')
          lastProxyError = `${modelId}: claude-ai quota truly exhausted (${respBody.slice(0, 80)})`
          console.log(`[proxy] ${lastProxyError}, trying next fallback`)
          return proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
        }
        // rate_limit_error — can mean temporary throttle OR model unavailable
        // at current subscription tier. Since we can't distinguish, treat as
        // fallback-trigger: skip claude-ai, try next candidate. If ALL candidates
        // return 429, the final 529 will tell the user to check subscription tier.
        lastProxyError = `${modelId}: claude-ai rate limited (${respBody.slice(0, 80)})`
        console.log(`[proxy] ${lastProxyError}, trying next fallback`)
        proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
      })
      return
    }

    // 401 from claude-ai — token may have been revoked mid-flight, try refresh once
    if (proxyRes.statusCode === 401 && modelConfig.provider === 'claude-ai') {
      proxyRes.resume()
      console.log(`[proxy] ${modelId}: claude-ai 401, attempting token refresh...`)
      const newToken = await refreshClaudeToken(
        JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))?.claudeAiOauth?.refreshToken
      )
      if (newToken) {
        console.log(`[proxy] ${modelId}: token refreshed after 401, retrying same provider`)
        return proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx, retries: 0 })
      }
      console.log(`[proxy] ${modelId}: refresh failed after 401, skipping to next fallback`)
      return proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
    }

    if (proxyRes.statusCode === 429 && modelConfig.provider === 'anthropic') {
      const chunks429 = []
      proxyRes.on('data', c => chunks429.push(c))
      proxyRes.on('end', () => {
        let isQuota = false
        try {
          const body = JSON.parse(Buffer.concat(chunks429).toString())
          const errType = body?.error?.type || ''
          isQuota = errType !== 'rate_limit_error'
        } catch { isQuota = false }

        if (isQuota) {
          markQuotaExhausted('anthropic')
          lastProxyError = `${modelId}: anthropic quota truly exhausted`
          console.log(`[proxy] ${lastProxyError}, trying next fallback`)
          return proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
        }
        // Temporary rate limit — pass through 429 with friendlier message
        console.log(`[proxy] anthropic rate limit hit for ${modelId} (temporary, not marking exhausted)`)
        if (!res.headersSent) {
          try {
            const err = JSON.parse(Buffer.concat(chunks429).toString())
            err.error.message = `[Anthropic API] 请求过于频繁，已被临时限速（约 1 分钟后恢复）。Claude Code 将自动重试，请稍候。原始错误: ${err.error?.message || 'rate_limit_error'}`
            res.writeHead(429, { 'content-type': 'application/json' })
            res.end(JSON.stringify(err))
          } catch {
            res.writeHead(429, { 'content-type': 'application/json' })
            res.end(Buffer.concat(chunks429))
          }
        }
      })
      return
    }

    // 4xx / 5xx from upstream that isn't quota — could be a provider issue, try next fallback
    if (proxyRes.statusCode >= 400 && proxyRes.statusCode !== 429) {
      const chunks = []
      proxyRes.on('data', c => chunks.push(c))
      proxyRes.on('end', () => {
        let errMsg = `HTTP ${proxyRes.statusCode}`
        try { const b = JSON.parse(Buffer.concat(chunks).toString()); errMsg = b?.error?.message || errMsg } catch {}
        lastProxyError = `${modelId}: ${errMsg}`
        console.log(`[proxy] ${lastProxyError}, trying next fallback`)
        proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
      })
      return
    }

    // Success — if fallback happened, buffer full response and inject notice
    if (idx > 0) {
      const chunks = []
      proxyRes.on('data', c => chunks.push(c))
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString()
        const notice = buildFallbackNotice(originalModelId, modelId)
        const modified = injectNoticeIntoResponse(responseBody, notice)
        writeFallbackAlert(originalModelId, modelId)

        if (isStreaming) {
          const sse = jsonToSSE(modified)
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'transfer-encoding': 'chunked'
          })
          res.end(sse)
        } else {
          res.writeHead(proxyRes.statusCode, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(modified)
          })
          res.end(modified)
        }
      })
    } else {
      // Primary hop (idx === 0): pipe upstream response directly.
      // The 300s body timeout on proxyReq handles hung-upstream detection.
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    }
  })

  proxyReq.on('error', (err) => {
    const isTransient = err.message === 'socket hang up' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
    if (isTransient && retries < 2) {
      const delay = (retries + 1) * 1500
      console.log(`[proxy] ${modelId}: transient error (${err.message}), retrying in ${delay}ms (attempt ${retries + 1}/2)`)
      setTimeout(() => proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx, retries: retries + 1, originalModelId, isStreaming }), delay)
      return
    }
    lastProxyError = `${modelId}: ${err.message}`
    console.error(`[proxy] ${lastProxyError}, trying next fallback`)
    proxyRequest(req, res, rawBody, sessionId, effectiveUrl, { candidates, idx: idx + 1, retries: 0, originalModelId, isStreaming })
  })

  proxyReq.setTimeout(60000, () => {
    proxyReq.destroy(new Error('upstream timeout'))
  })

  proxyReq.write(bodyStr)
  proxyReq.end()
}

function sendOutOfQuota(res) {
  if (!res.headersSent) {
    res.writeHead(529, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'overload_error',
        message: `所有可用渠道额度已耗尽（订阅 / Anthropic API Key / DeepSeek）。请等待额度恢复（约 5 小时）后重试，或删除 ~/.claude/proxy/quota-status.json 手动重置。最后错误: ${lastProxyError || '无'}`,
        details: lastProxyError || ''
      }
    }))
  }
}

const server = http.createServer((req, res) => {

  const { sessionId, actualUrl } = parseSessionUrl(req.url)

  if (req.method === 'GET' && actualUrl.replace(/\?.*$/, '').endsWith('/models')) {
    handleModelsList(res)
    return
  }

  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    proxyRequest(req, res, Buffer.concat(chunks), sessionId, actualUrl).catch(err => {
      console.error('[proxy] Unhandled proxyRequest error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal proxy error', details: err.message }))
      }
    })
  })
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
