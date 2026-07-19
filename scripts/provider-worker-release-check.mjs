import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const manifestPath = path.join(root, 'provider-worker-runtime-files.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const files = Array.isArray(manifest.files) ? manifest.files : []
const forbidden = [
  'gateway/',
  'src/edge/',
  'src/admin',
  'src/routes/',
  'src/server.js',
  'src/config.js',
  'codex-proxy-config.json',
  'codex-proxy-stats.json'
]

function fail(message) {
  console.error(`[provider-worker-release] ${message}`)
  process.exitCode = 1
}

if (manifest.schema_version !== 1) fail('unsupported manifest schema')
if (manifest.target !== 'provider-worker') fail('manifest target must be provider-worker')
if (manifest.entry !== 'src/launcher.js') fail('manifest entry must use the shared mode launcher')
if (!files.length) fail('runtime manifest is empty')
if (new Set(files).size !== files.length) fail('runtime manifest contains duplicate files')

for (const file of files) {
  if (
    path.isAbsolute(file) ||
    file.includes('..') ||
    file.includes('\\') ||
    forbidden.some(prefix => file === prefix || file.startsWith(prefix))
  ) {
    fail(`forbidden Provider Worker runtime path: ${file}`)
    continue
  }
  if (!fs.existsSync(path.join(root, file))) fail(`runtime file is missing: ${file}`)
}

for (const file of files.filter(file => /\.(?:js|cjs|mjs)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit'
  })
  if (result.status !== 0) fail(`syntax check failed: ${file}`)
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`[provider-worker-release] boundary passed for ${files.length} files`)
