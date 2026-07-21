// Request logging
import fs from 'fs'
import os from 'os'
import path from 'path'
import { redactSecretText } from './secret-scan.js'

const REQUEST_LOG = path.join(os.homedir(), '.claude', 'proxy', 'codex-proxy-requests.log')
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
      console.error('[codex-proxy] request log rotation failed:', safeErrorText(error))
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
  return redactSecretText(value)
}

export function safeErrorText(error, maxLength = 1000) {
  return redactSecrets(error?.message || error || 'Unknown error').slice(0, maxLength)
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
