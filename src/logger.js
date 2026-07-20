// Request logging
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const REQUEST_LOG = process.env.CODEX_PROXY_STORAGE_ROOT
  ? path.join(
      path.resolve(process.env.CODEX_PROXY_STORAGE_ROOT),
      'logs',
      'codex-proxy-requests.log'
    )
  : path.join(os.homedir(), '.claude', 'proxy', 'codex-proxy-requests.log')
const MAX_LOG_BYTES = 10 * 1024 * 1024
let writesSinceSizeCheck = 100

try { fs.mkdirSync(path.dirname(REQUEST_LOG), { recursive: true }) } catch {}

function rotateRequestLogIfNeeded() {
  if (++writesSinceSizeCheck < 100) return
  writesSinceSizeCheck = 0
  try {
    if (fs.statSync(REQUEST_LOG).size < MAX_LOG_BYTES) return
    const previous = REQUEST_LOG + '.1'
    try { fs.rmSync(previous, { force: true }) } catch {}
    fs.renameSync(REQUEST_LOG, previous)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[codex-proxy] request log rotation failed:', error.message)
    }
  }
}

function isNoisyAdminRead(req) {
  if (req.method !== 'GET') return false
  const pathname = String(req.url || '').split('?', 1)[0]
  return pathname === '/admin/api/config' ||
    pathname === '/admin/api/stats' ||
    pathname === '/admin/api/diagnostics' ||
    pathname === '/v1/models'
}

export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[^\s|,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9._-]{8,}|rt\.[A-Za-z0-9._-]{8,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&](?:api_?key|access_?token|refresh_?token|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:api_?key|access_?token|refresh_?token|authorization|password|secret|token)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/\b(password|secret|token)\s*[=:]\s*[^\s|,;]+/gi, '$1=[REDACTED]')
}

export function summarizeUpstreamErrorBody(value) {
  const raw = String(value ?? '')
  if (!raw.trim()) return 'empty_body'

  try {
    const payload = JSON.parse(raw)
    const source = payload?.error && typeof payload.error === 'object'
      ? payload.error
      : payload
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return 'json_body_without_error_fields'
    }

    const fields = []
    for (const key of ['type', 'code', 'param', 'message']) {
      const field = source[key]
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
        fields.push(`${key}=${String(field).replace(/\s+/g, ' ').slice(0, 500)}`)
      }
    }
    if (!fields.length) {
      return `json_error_keys=${Object.keys(source).slice(0, 12).join(',') || 'none'}`
    }
    return redactSecrets(fields.join(' | ')).slice(0, 1200)
  } catch {
    const bytes = Buffer.byteLength(raw)
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
    return `non_json_body bytes=${bytes} sha256=${digest}`
  }
}

export function requestLog(req, extra = '') {
  if (!extra && isNoisyAdminRead(req)) return
  const ts = new Date().toISOString()
  const requestId = req.requestId ? ` | ID=${req.requestId}` : ''
  const safeUrl = redactSecrets(req.url)
  const safeUa = redactSecrets(req.headers['user-agent']?.slice(0, 80) || 'none')
  const safeExtra = redactSecrets(extra)
  const line = `${ts} ${req.method} ${safeUrl}${requestId} | UA=${safeUa} | CT=${req.headers['content-type'] || 'none'} | Auth=${req.headers['authorization'] ? 'yes' : 'no'}${safeExtra ? ' | ' + safeExtra : ''}\n`
  try {
    rotateRequestLogIfNeeded()
    fs.appendFileSync(REQUEST_LOG, line)
  } catch {}
}
