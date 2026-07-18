// Imported first (before any ../src/* module) so config.js/stats.js resolve
// STORAGE_ROOT to a throwaway temp dir instead of the real repo root — tests
// that call resetStats()/atomicWriteJson must never touch production files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-test-'))
process.env.CODEX_PROXY_STORAGE_ROOT = storageRoot

process.on('exit', () => {
  try {
    fs.rmSync(storageRoot, { recursive: true, force: true })
  } catch {}
})
