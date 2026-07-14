import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_ROOT = path.resolve(__dirname, '..')
const RUNTIME_ENTRY = path.join(__dirname, 'server.js')
const STARTED_AT = new Date().toISOString()
const DEFAULT_INSTALL_ROOT = path.join(os.homedir(), '.codex-local-multi-proxy')
const RELEASE_MANIFEST = '.release-manifest.json'
const LAST_DEPLOYMENT = '.last-deployment.json'

function readJson(file, fallback = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function normalizeRoot(value) {
  if (!value) return null
  try { return path.resolve(String(value)) } catch { return null }
}

function samePath(left, right) {
  const a = normalizeRoot(left)
  const b = normalizeRoot(right)
  if (!a || !b) return false
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

function packageVersion(root) {
  return readJson(path.join(root, 'package.json'), {})?.version || null
}

function gitCommit(root) {
  if (!root || !fs.existsSync(path.join(root, '.git'))) return null
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    return result.status === 0 ? String(result.stdout || '').trim() || null : null
  } catch {
    return null
  }
}

function fileHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function runtimeFileList(root) {
  const manifest = readJson(path.join(root, 'runtime-files.json'), {})
  return Array.isArray(manifest.files)
    ? manifest.files.map(value => String(value).replace(/\\/g, '/')).filter(Boolean)
    : []
}

function locationInfo(root, manifest = null) {
  if (!root) return null
  const release = manifest || readJson(path.join(root, RELEASE_MANIFEST), {})
  return {
    path: root,
    exists: fs.existsSync(root),
    version: release.version || packageVersion(root),
    commit: release.commit || gitCommit(root),
    deployed_at: release.deployed_at || null,
    manifest_source: release.source_root || null
  }
}

export function compareRuntimeTrees(sourceRoot, installRoot, files = null) {
  const source = normalizeRoot(sourceRoot)
  const install = normalizeRoot(installRoot)
  if (!source || !install || !fs.existsSync(source) || !fs.existsSync(install)) {
    return { synchronized: null, differences: [], checked_files: 0 }
  }
  const runtimeFiles = files || runtimeFileList(source)
  const differences = []
  for (const relativePath of runtimeFiles) {
    const sourceFile = path.join(source, relativePath)
    const installFile = path.join(install, relativePath)
    const sourceHash = fileHash(sourceFile)
    const installedHash = fileHash(installFile)
    if (sourceHash === installedHash && sourceHash) continue
    differences.push({
      file: relativePath,
      status: !sourceHash ? 'missing_source' : (!installedHash ? 'missing_installation' : 'content_mismatch'),
      source_hash: sourceHash,
      installed_hash: installedHash
    })
  }
  return {
    synchronized: differences.length === 0,
    differences,
    checked_files: runtimeFiles.length
  }
}

export function getRuntimeDeploymentInfo({
  runtimeRoot = RUNTIME_ROOT,
  installRoot = process.env.CODEX_PROXY_INSTALL_DIR || DEFAULT_INSTALL_ROOT,
  sourceRoot = process.env.CODEX_PROXY_SOURCE_DIR || null
} = {}) {
  const runtime = normalizeRoot(runtimeRoot)
  const install = normalizeRoot(installRoot)
  const runtimeManifest = readJson(path.join(runtime, RELEASE_MANIFEST), {})
  const source = normalizeRoot(
    sourceRoot ||
    runtimeManifest.source_root ||
    (fs.existsSync(path.join(runtime, '.git')) ? runtime : null)
  )
  const comparison = compareRuntimeTrees(source, install)
  const runningFromInstall = samePath(runtime, install)
  const runningFromSource = source ? samePath(runtime, source) : false
  let status = 'source_unavailable'
  if (comparison.synchronized === true) status = runningFromInstall ? 'synchronized' : 'workspace_matches_installation'
  else if (comparison.synchronized === false) status = runningFromInstall ? 'installation_outdated' : 'workspace_not_deployed'

  return {
    runtime: {
      path: runtime,
      entry: path.resolve(runtime, path.relative(RUNTIME_ROOT, RUNTIME_ENTRY)),
      version: runtimeManifest.version || packageVersion(runtime),
      commit: runtimeManifest.commit || gitCommit(runtime),
      started_at: STARTED_AT,
      pid: process.pid,
      role: runningFromInstall ? 'installation' : (runningFromSource ? 'workspace' : 'custom')
    },
    source: locationInfo(source),
    installation: locationInfo(install),
    consistency: {
      status,
      synchronized: comparison.synchronized,
      checked_files: comparison.checked_files,
      difference_count: comparison.differences.length,
      differences: comparison.differences.slice(0, 50)
    },
    can_deploy: Boolean(source && install && !samePath(source, install) && comparison.synchronized === false),
    update_script: source ? path.join(source, 'update-codex-proxy.ps1') : null,
    last_deployment: install ? readJson(path.join(install, LAST_DEPLOYMENT), null) : null
  }
}

export function runtimeStartedAt() {
  return STARTED_AT
}
