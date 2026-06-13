import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const sessionId = 's' + randomBytes(4).toString('hex')
const sessionsDir = join(homedir(), '.claude', 'proxy', 'sessions')
mkdirSync(sessionsDir, { recursive: true })

// argv[2] = CLAUDE_CODE_SESSION_ID, unique per window, always present in bash env.
// Used by /models skill to look up the proxy session ID without relying on PPID
// (which is always 1 in the bash sandbox) or ANTHROPIC_BASE_URL injection (which
// doesn't propagate to bash subprocesses).
const ccSessionId = process.argv[2]
if (ccSessionId) {
  writeFileSync(join(sessionsDir, `by-cc-session-${ccSessionId}.txt`), sessionId)
}

process.stdout.write(JSON.stringify({
  env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:47891/s/${sessionId}` }
}))
