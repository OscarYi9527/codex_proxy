// Request logging
import fs from 'fs'
import os from 'os'
import path from 'path'

const REQUEST_LOG = path.join(os.homedir(), '.claude', 'proxy', 'codex-proxy-requests.log')

try { fs.mkdirSync(path.dirname(REQUEST_LOG), { recursive: true }) } catch {}

export function requestLog(req, extra = '') {
  const ts = new Date().toISOString()
  const line = `${ts} ${req.method} ${req.url} | UA=${req.headers['user-agent']?.slice(0, 80) || 'none'} | CT=${req.headers['content-type'] || 'none'} | Auth=${req.headers['authorization'] ? 'yes' : 'no'}${extra ? ' | ' + extra : ''}\n`
  try { fs.appendFileSync(REQUEST_LOG, line) } catch {}
}
