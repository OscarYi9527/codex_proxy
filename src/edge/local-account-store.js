import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DPAPI_ENTROPY = Buffer.from('ai-editor-edge-refresh-token-v1', 'utf8')

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  fs.renameSync(temporary, file)
  try { fs.chmodSync(file, 0o600) } catch {}
}

function runDpapi(mode, value, runner = spawnSync) {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
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
  const protectedValue = mode === 'unprotect' ? String(value).trim() : null
  if (
    protectedValue !== null &&
    (
      protectedValue.length === 0 ||
      protectedValue.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(protectedValue) ||
      Buffer.from(protectedValue, 'base64').toString('base64') !== protectedValue
    )
  ) {
    throw new Error('Edge DPAPI ciphertext is not valid base64')
  }
  const input = Buffer.from(
    mode === 'protect'
      ? Buffer.from(value, 'utf8').toString('base64')
      : protectedValue,
    'ascii'
  )
  try {
    const result = runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: input.toString('ascii'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    })
    const output = String(result.stdout || '').trim()
    if (
      result.status !== 0 ||
      output.length === 0 ||
      output.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(output) ||
      Buffer.from(output, 'base64').toString('base64') !== output
    ) {
      throw new Error(`DPAPI ${mode} failed`)
    }
    // ProtectedData returns arbitrary binary bytes. Persist their canonical
    // base64 text instead of decoding them as UTF-8, which corrupts most
    // ciphertext and makes the next Edge process unable to unseal it.
    return mode === 'protect'
      ? output
      : Buffer.from(output, 'base64').toString('utf8')
  } finally {
    input.fill(0)
  }
}

export class WindowsDpapiRefreshTokenStore {
  constructor(options) {
    this.file = path.join(options.dataRoot, 'edge-account-binding.dpapi.json')
    this.runner = options.runner || spawnSync
  }

  async load() {
    if (!fs.existsSync(this.file)) return null
    const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (
      envelope?.version !== 2 ||
      envelope?.protection !== 'Windows DPAPI CurrentUser' ||
      envelope?.encoding !== 'base64' ||
      typeof envelope.deviceSessionId !== 'string' ||
      typeof envelope.protectedRefreshToken !== 'string'
    ) {
      throw new Error('Edge DPAPI binding envelope is invalid')
    }
    return {
      deviceSessionId: envelope.deviceSessionId,
      refreshToken: runDpapi('unprotect', envelope.protectedRefreshToken, this.runner)
    }
  }

  async save(binding) {
    const protectedRefreshToken = runDpapi('protect', binding.refreshToken, this.runner)
    atomicWriteJson(this.file, {
      version: 2,
      protection: 'Windows DPAPI CurrentUser',
      encoding: 'base64',
      deviceSessionId: binding.deviceSessionId,
      protectedRefreshToken
    })
  }

  async clear() {
    fs.rmSync(this.file, { force: true })
  }
}

export class MacKeychainRefreshTokenStore {
  constructor(options) {
    this.dataRoot = options.dataRoot
    this.metadataFile = path.join(options.dataRoot, 'edge-account-binding.keychain.json')
    this.service = options.service || 'ai-editor-edge-refresh-token'
    this.account = options.account || crypto
      .createHash('sha256')
      .update(path.resolve(options.dataRoot))
      .digest('hex')
      .slice(0, 32)
    this.runner = options.runner || spawnSync
  }

  run(args, input) {
    const result = this.runner('/usr/bin/security', args, {
      ...(input === undefined ? {} : { input }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    })
    return result
  }

  async load() {
    if (!fs.existsSync(this.metadataFile)) return null
    const metadata = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8'))
    if (
      metadata?.version !== 1 ||
      metadata?.service !== this.service ||
      metadata?.account !== this.account ||
      typeof metadata.deviceSessionId !== 'string'
    ) {
      throw new Error('Edge Keychain binding metadata is invalid')
    }
    const result = this.run([
      'find-generic-password',
      '-s', this.service,
      '-a', this.account,
      '-w'
    ])
    if (result.status !== 0) throw new Error('macOS Keychain token is unavailable')
    return {
      deviceSessionId: metadata.deviceSessionId,
      refreshToken: String(result.stdout || '').trim()
    }
  }

  async save(binding) {
    const input = Buffer.from(`${binding.refreshToken}\n`, 'utf8')
    try {
      // A trailing -w prompts through stdin when no TTY is attached, keeping
      // the Refresh Token out of argv and process listings.
      const result = this.run([
        'add-generic-password',
        '-U',
        '-s', this.service,
        '-a', this.account,
        '-w'
      ], input)
      if (result.status !== 0) throw new Error('macOS Keychain token save failed')
    } finally {
      input.fill(0)
    }
    atomicWriteJson(this.metadataFile, {
      version: 1,
      service: this.service,
      account: this.account,
      deviceSessionId: binding.deviceSessionId
    })
  }

  async clear() {
    this.run(['delete-generic-password', '-s', this.service, '-a', this.account])
    fs.rmSync(this.metadataFile, { force: true })
  }
}

export class MemoryRefreshTokenStore {
  constructor() {
    this.value = null
  }

  async load() {
    return this.value ? { ...this.value } : null
  }

  async save(value) {
    this.value = { ...value }
  }

  async clear() {
    this.value = null
  }
}

export function createPlatformRefreshTokenStore(options) {
  const platform = options.platform || process.platform
  if (platform === 'win32') return new WindowsDpapiRefreshTokenStore(options)
  if (platform === 'darwin') return new MacKeychainRefreshTokenStore(options)
  throw new Error(`Edge secure Refresh Token storage is unsupported on ${platform}`)
}

export class LocalAccountBindingStore {
  constructor(options) {
    this.secureStore = options.secureStore
    this.now = options.now || (() => Date.now())
    this.binding = null
    this.bindingVersion = 0
    this.queue = Promise.resolve()
    this.initialized = false
  }

  async initialize() {
    if (this.initialized) return
    await this.exclusive(async () => {
      if (this.initialized) return
      let persisted = null
      try {
        persisted = await this.secureStore.load()
      } catch {
        // A Refresh Token that cannot be unsealed must never keep the Edge
        // process offline. Remove the unusable local binding and fail closed
        // as login_required so the user can establish a fresh secure handoff.
        try {
          await this.secureStore.clear()
        } catch {
          // A later successful handoff atomically replaces a stale file.
        }
      }
      if (persisted) {
        this.bindingVersion += 1
        this.binding = {
          bindingVersion: this.bindingVersion,
          deviceSessionId: persisted.deviceSessionId,
          refreshToken: persisted.refreshToken,
          accessToken: null,
          accessTokenExpiresAt: 0
        }
      }
      this.initialized = true
    })
  }

  async completeHandoff(tokens) {
    return this.exclusive(async () => {
      await this.secureStore.save({
        deviceSessionId: tokens.deviceSessionId,
        refreshToken: tokens.refreshToken
      })
      this.bindingVersion += 1
      this.binding = {
        bindingVersion: this.bindingVersion,
        deviceSessionId: tokens.deviceSessionId,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: this.now() + Number(tokens.accessTokenExpiresIn) * 1000
      }
      this.initialized = true
      return this.bindingVersion
    })
  }

  snapshot() {
    return this.binding ? { ...this.binding } : null
  }

  async updateAfterRefresh(expectedVersion, tokens) {
    return this.exclusive(async () => {
      if (
        !this.binding ||
        this.binding.bindingVersion !== expectedVersion ||
        this.binding.deviceSessionId !== tokens.deviceSessionId
      ) {
        return false
      }
      await this.secureStore.save({
        deviceSessionId: tokens.deviceSessionId,
        refreshToken: tokens.refreshToken
      })
      this.binding = {
        ...this.binding,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: this.now() + Number(tokens.accessTokenExpiresIn) * 1000
      }
      return true
    })
  }

  async clear(expectedVersion) {
    return this.exclusive(async () => {
      if (
        expectedVersion !== undefined &&
        this.binding &&
        this.binding.bindingVersion !== expectedVersion
      ) {
        return false
      }
      await this.secureStore.clear()
      this.bindingVersion += 1
      this.binding = null
      this.initialized = true
      return true
    })
  }

  async exclusive(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
