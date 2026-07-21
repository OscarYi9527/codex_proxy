import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const fail = message => {
  console.error(`[release-check] ${message}`)
  process.exitCode = 1
}

function run(command, args, label, options = {}) {
  console.log(`[release-check] ${label}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
    env: options.env || process.env
  })
  if (result.error) {
    fail(`${label}: ${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status}`)
    return false
  }
  return true
}

const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const runtime = readJson('runtime-files.json')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  fail(
    'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification. ' +
    'Clear it before release checks; use NODE_EXTRA_CA_CERTS for a trusted custom CA.'
  )
}

if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) {
  fail(`package versions differ: package=${pkg.version}, lock=${lock.version}, lock root=${lock.packages?.['']?.version}`)
}
if (!readme.includes(`当前版本：**${pkg.version}**`)) {
  fail(`README does not declare current version ${pkg.version}`)
}
if (!changelog.includes(`## [${pkg.version}]`)) {
  fail(`CHANGELOG does not contain an entry for ${pkg.version}`)
}

const files = Array.isArray(runtime.files) ? runtime.files : []
const duplicates = files.filter((file, index) => files.indexOf(file) !== index)
if (duplicates.length) fail(`runtime-files.json has duplicates: ${[...new Set(duplicates)].join(', ')}`)
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) fail(`runtime file is missing: ${file}`)
}

if (process.exitCode) process.exit(process.exitCode)

for (const file of files.filter(file => /\.(?:js|cjs|mjs)$/.test(file))) {
  if (!run(process.execPath, ['--check', file], `syntax ${file}`)) process.exit(1)
}

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const parsePowerShell = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:CODEX_RELEASE_CHECK_FILE,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{[Console]::Error.WriteLine($_.Message)};exit 1}'
]
for (const file of files.filter(file => file.endsWith('.ps1'))) {
  if (!run(powershell, parsePowerShell, `PowerShell syntax ${file}`, {
    env: { ...process.env, CODEX_RELEASE_CHECK_FILE: path.join(root, file) }
  })) process.exit(1)
}

const npmCli = process.env.npm_execpath
function runNpm(args, label) {
  return npmCli
    ? run(process.execPath, [npmCli, ...args], label)
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, label)
}

for (const [script, label] of [
  ['test', 'standalone and Edge tests'],
  ['gateway:test', 'Gateway tests'],
  ['admin:test', 'admin-web tests'],
  ['test:dev-scripts', 'isolated development script tests'],
  ['check', 'workspace type and syntax checks'],
  ['gateway:build', 'Gateway production build'],
  ['admin:build', 'admin-web production build']
]) {
  if (!runNpm(['run', script], label)) process.exit(1)
}
if (!run('git', ['diff', '--check'], 'whitespace check')) process.exit(1)

console.log(`[release-check] release gate passed for ${pkg.version}`)
