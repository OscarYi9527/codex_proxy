import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const ENCRYPTED_PREFIX = 'dpapi-aesgcm:v1:'
const DPAPI_ENTROPY = Buffer.from('codex-proxy-local-credentials-v1', 'utf8')
let credentialKey = null
let credentialKeyFile = null

function powershellDpapi(mode, input) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const operation = mode === 'protect' ? 'Protect' : 'Unprotect'
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$raw=[Console]::In.ReadToEnd().Trim()',
    '$bytes=[Convert]::FromBase64String($raw)',
    `$entropy=[Convert]::FromBase64String('${DPAPI_ENTROPY.toString('base64')}')`,
    `$result=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))'
  ].join(';')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(input).toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
  if (result.status !== 0 || !String(result.stdout || '').trim()) {
    throw new Error(`Windows DPAPI ${mode} failed: ${String(result.stderr || '').trim() || `exit ${result.status}`}`)
  }
  return Buffer.from(result.stdout.trim(), 'base64')
}

export function initializeCredentialStore(baseDir) {
  if (process.platform !== 'win32') return { enabled: false, reason: 'DPAPI is only available on Windows' }
  credentialKeyFile = path.join(baseDir, '.credential-key.dpapi.json')
  if (fs.existsSync(credentialKeyFile)) {
    const envelope = JSON.parse(fs.readFileSync(credentialKeyFile, 'utf8'))
    if (envelope?.version !== 1 || !envelope.protected_key) throw new Error('DPAPI credential key file is invalid')
    credentialKey = powershellDpapi('unprotect', Buffer.from(envelope.protected_key, 'base64'))
  } else {
    credentialKey = crypto.randomBytes(32)
    const protectedKey = powershellDpapi('protect', credentialKey)
    const temp = `${credentialKeyFile}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify({
      version: 1,
      protection: 'Windows DPAPI CurrentUser',
      created_at: new Date().toISOString(),
      protected_key: protectedKey.toString('base64')
    }, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, credentialKeyFile)
    try { fs.chmodSync(credentialKeyFile, 0o600) } catch {}
  }
  if (credentialKey.length !== 32) throw new Error('DPAPI credential key has an invalid length')
  return { enabled: true, keyFile: credentialKeyFile }
}

export function credentialStoreEnabled() {
  return Buffer.isBuffer(credentialKey) && credentialKey.length === 32
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

export function encryptSecret(value, key = credentialKey) {
  if (typeof value !== 'string' || !value || isEncryptedSecret(value)) return value
  if (!Buffer.isBuffer(key) || key.length !== 32) return value
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(value, key = credentialKey) {
  if (!isEncryptedSecret(value)) return value
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Encrypted credentials are present but the DPAPI key is unavailable')
  }
  const parts = value.slice(ENCRYPTED_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('Encrypted credential has an invalid format')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'))
  decipher.setAuthTag(Buffer.from(parts[1], 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(parts[2], 'base64')),
    decipher.final()
  ]).toString('utf8')
}

function transformConfig(config, transform) {
  const result = structuredClone(config || {})
  for (const key of ['deepseek_api_key', 'openai_api_key']) {
    if (result[key] != null) result[key] = transform(result[key])
  }
  result.relays = (result.relays || []).map(relay => ({
    ...relay,
    api_key: transform(relay.api_key)
  }))
  result.chatgpt_accounts = (result.chatgpt_accounts || []).map(account => {
    const copy = { ...account }
    for (const key of ['access_token', 'refresh_token', 'id_token']) {
      if (copy[key] != null) copy[key] = transform(copy[key])
    }
    return copy
  })
  return result
}

export function encryptConfigSecrets(config, key = credentialKey) {
  return transformConfig(config, value => encryptSecret(value, key))
}

export function decryptConfigSecrets(config, key = credentialKey) {
  return transformConfig(config, value => decryptSecret(value, key))
}
