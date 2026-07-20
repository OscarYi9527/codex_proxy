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
  'src/server.js',
  'codex-proxy-config.json',
  'codex-proxy-stats.json'
]
const allowedSharedRoutes = new Set([
  'src/routes/chatgpt-sub.js'
])
const targetConditionalImports = new Map([
  ['src/launcher.js', new Set([
    'src/server.js',
    'src/edge/edge-server.js'
  ])]
])

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
  if (file.startsWith('src/routes/') && !allowedSharedRoutes.has(file)) {
    fail(`unapproved shared Provider route: ${file}`)
  }
  if (!fs.existsSync(path.join(root, file))) fail(`runtime file is missing: ${file}`)
}

const scriptFiles = files.filter(file => /\.(?:js|cjs|mjs)$/.test(file))
const runtimeFiles = new Set(files)
for (const file of scriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit'
  })
  if (result.status !== 0) fail(`syntax check failed: ${file}`)

  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)
  ].map(match => match[1])
  for (const specifier of specifiers.filter(value => value.startsWith('.'))) {
    const resolved = path
      .relative(root, path.resolve(root, path.dirname(file), specifier))
      .replaceAll('\\', '/')
    if (
      !runtimeFiles.has(resolved) &&
      !targetConditionalImports.get(file)?.has(resolved)
    ) {
      fail(`runtime import is missing from manifest: ${file} -> ${resolved}`)
    }
  }
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`[provider-worker-release] boundary passed for ${files.length} files`)
