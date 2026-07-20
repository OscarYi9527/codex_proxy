import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const releaseParent = path.join(root, '.ai-editor-release')
const target = path.join(releaseParent, 'provider-worker')
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, 'provider-worker-runtime-files.json'),
  'utf8'
))

function assertSafeTarget(value) {
  const resolved = path.resolve(value)
  const prefix = `${path.resolve(releaseParent)}${path.sep}`
  if (!resolved.startsWith(prefix) || resolved === path.resolve(releaseParent)) {
    throw new Error(`Provider Worker release target escaped ${releaseParent}`)
  }
  return resolved
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

assertSafeTarget(target)
if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })

for (const file of manifest.files) {
  const source = path.join(root, file)
  const destination = path.join(target, file)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({
  name: '@ai-editor/provider-worker-runtime',
  version: '0.1.0',
  private: true,
  type: 'module',
  engines: { node: '>=22.19.0' },
  dependencies: {
    undici: '^8.7.0'
  },
  scripts: {
    start: 'node src/launcher.js --mode provider-worker'
  }
}, null, 2)}\n`)

const git = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  shell: false
})
const files = [...manifest.files, 'package.json']
const release = {
  schema_version: 1,
  target: 'provider-worker',
  commit: git.status === 0 ? git.stdout.trim() : null,
  created_at: new Date().toISOString(),
  entry: 'src/launcher.js',
  files: Object.fromEntries(files.map(file => [
    file,
    sha256(path.join(target, file))
  ]))
}
fs.writeFileSync(
  path.join(target, 'release.json'),
  `${JSON.stringify(release, null, 2)}\n`
)
console.log(`[provider-worker-release] built ${files.length} files at ${target}`)
