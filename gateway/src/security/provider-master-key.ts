import crypto, { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { GatewayConfig } from '../config.js'

const DPAPI_ENTROPY = Buffer.from('ai-editor-gateway-provider-master-keys-v1', 'utf8')
export const PROVIDER_KEYRING_ENV = 'AI_EDITOR_GATEWAY_PROVIDER_KEYRING'
export const PROVIDER_ACTIVE_KEY_ENV = 'AI_EDITOR_GATEWAY_PROVIDER_ACTIVE_KEY_ID'
const MAX_PROVIDER_KEYS = 16

interface SerializedKeyring {
  readonly version: 1
  readonly active_key_id: string
  readonly keys: Record<string, string>
}

export interface ProviderCredentialKeyring {
  readonly activeKeyId: string
  readonly protection: string
  getKey(keyId: string): Uint8Array | null
  keyIds(): readonly string[]
}

type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    input?: string | Buffer
    encoding: 'utf8'
    windowsHide: boolean
    timeout: number
  }
) => SpawnSyncReturns<string>

function validKeyId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(value)
}

function decodeKey(value: string, keyId: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Provider master key ${keyId} must use canonical Base64`)
  }
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error(`Provider master key ${keyId} must decode to exactly 32 bytes`)
  }
  return new Uint8Array(key)
}

function parseSerialized(value: unknown, protection: string): StaticProviderCredentialKeyring {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider master keyring is invalid')
  }
  const parsed = value as Partial<SerializedKeyring>
  if (parsed.version !== 1 || !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error('Provider master keyring version is unsupported')
  }
  const activeKeyId = String(parsed.active_key_id || '')
  if (!validKeyId(activeKeyId)) throw new Error('Provider active key ID is invalid')
  const keys = new Map<string, Uint8Array>()
  for (const [keyId, encoded] of Object.entries(parsed.keys)) {
    if (!validKeyId(keyId) || typeof encoded !== 'string') {
      throw new Error('Provider master keyring contains an invalid key entry')
    }
    keys.set(keyId, decodeKey(encoded, keyId))
  }
  if (!keys.has(activeKeyId)) throw new Error('Provider active key is missing from keyring')
  if (keys.size > MAX_PROVIDER_KEYS) {
    throw new Error(`Provider master keyring exceeds ${MAX_PROVIDER_KEYS} keys`)
  }
  return new StaticProviderCredentialKeyring(activeKeyId, keys, protection)
}

function serialize(keyring: ProviderCredentialKeyring): SerializedKeyring {
  return {
    version: 1,
    active_key_id: keyring.activeKeyId,
    keys: Object.fromEntries(keyring.keyIds().map(keyId => {
      const key = keyring.getKey(keyId)
      if (!key) throw new Error(`Provider master key ${keyId} is unavailable`)
      return [keyId, Buffer.from(key).toString('base64')]
    }))
  }
}

function newKeyring(protection: string): StaticProviderCredentialKeyring {
  const keyId = `provider-key-${randomBytes(8).toString('hex')}`
  return new StaticProviderCredentialKeyring(
    keyId,
    new Map([[keyId, new Uint8Array(randomBytes(32))]]),
    protection
  )
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows ACLs are inherited from the isolated data root.
  }
}

export class StaticProviderCredentialKeyring implements ProviderCredentialKeyring {
  readonly activeKeyId: string
  readonly protection: string
  readonly #keys: ReadonlyMap<string, Uint8Array>

  constructor(
    activeKeyId: string,
    keys: ReadonlyMap<string, Uint8Array>,
    protection = 'injected-keyring'
  ) {
    if (
      !validKeyId(activeKeyId) ||
      !keys.has(activeKeyId) ||
      keys.size < 1 ||
      keys.size > MAX_PROVIDER_KEYS
    ) {
      throw new Error('Provider active key configuration is invalid')
    }
    this.activeKeyId = activeKeyId
    this.protection = protection
    this.#keys = new Map(
      [...keys].map(([keyId, key]) => {
        if (!validKeyId(keyId) || key.length !== 32) {
          throw new Error(`Provider master key ${keyId} is invalid`)
        }
        return [keyId, new Uint8Array(key)]
      })
    )
  }

  getKey(keyId: string): Uint8Array | null {
    const key = this.#keys.get(keyId)
    return key ? new Uint8Array(key) : null
  }

  keyIds(): readonly string[] {
    return [...this.#keys.keys()]
  }
}

function environmentKeyring(env: NodeJS.ProcessEnv): ProviderCredentialKeyring | null {
  const raw = env[PROVIDER_KEYRING_ENV]
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${PROVIDER_KEYRING_ENV} must contain valid JSON`)
  }
  const record = parsed as Partial<SerializedKeyring>
  const activeKeyId = env[PROVIDER_ACTIVE_KEY_ENV] || record.active_key_id
  return parseSerialized(
    { ...record, active_key_id: activeKeyId },
    'environment-or-kms-adapter'
  )
}

function dpapi(
  mode: 'protect' | 'unprotect',
  value: Buffer,
  runner: ProcessRunner
): Buffer {
  const powershell = path.join(
    process.env['SystemRoot'] || 'C:\\Windows',
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
  const result = runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
  const output = String(result.stdout || '').trim()
  if (result.status !== 0 || !output) throw new Error(`Windows DPAPI ${mode} failed`)
  return Buffer.from(output, 'base64')
}

function loadWindowsKeyring(
  dataRoot: string,
  runner: ProcessRunner,
  options: {
    rotate?: boolean
    activeKeyId?: string
  } = {}
): ProviderCredentialKeyring {
  const file = path.join(dataRoot, 'gateway-provider-keys.dpapi.gateway-secret')
  let keyring: ProviderCredentialKeyring
  if (fs.existsSync(file)) {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version?: number
      protection?: string
      protected_payload?: string
    }
    if (
      envelope.version !== 1 ||
      envelope.protection !== 'Windows DPAPI CurrentUser' ||
      typeof envelope.protected_payload !== 'string'
    ) {
      throw new Error('Gateway Provider DPAPI key envelope is invalid')
    }
    const plaintext = dpapi(
      'unprotect',
      Buffer.from(envelope.protected_payload, 'base64'),
      runner
    )
    try {
      keyring = parseSerialized(
        JSON.parse(plaintext.toString('utf8')),
        'Windows DPAPI CurrentUser'
      )
    } finally {
      plaintext.fill(0)
    }
  } else {
    keyring = newKeyring('Windows DPAPI CurrentUser')
  }
  if (options.rotate) keyring = rotatedKeyring(keyring)
  if (options.activeKeyId) keyring = activatedKeyring(keyring, options.activeKeyId)
  if (!fs.existsSync(file) || options.rotate || options.activeKeyId) {
    const plaintext = Buffer.from(JSON.stringify(serialize(keyring)), 'utf8')
    try {
      const protectedPayload = dpapi('protect', plaintext, runner)
      atomicWriteJson(file, {
        version: 1,
        protection: 'Windows DPAPI CurrentUser',
        protected_payload: protectedPayload.toString('base64')
      })
    } finally {
      plaintext.fill(0)
    }
  }
  return keyring
}

function keychainIdentity(dataRoot: string) {
  return {
    service: 'ai-editor-gateway-provider-master-keys',
    account: crypto.createHash('sha256')
      .update(path.resolve(dataRoot))
      .digest('hex')
      .slice(0, 32)
  }
}

function runSecurity(
  runner: ProcessRunner,
  args: readonly string[],
  input?: Buffer
): SpawnSyncReturns<string> {
  return runner('/usr/bin/security', args, {
    ...(input ? { input } : {}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
}

function loadMacKeyring(
  dataRoot: string,
  runner: ProcessRunner,
  options: {
    rotate?: boolean
    activeKeyId?: string
  } = {}
): ProviderCredentialKeyring {
  const metadataFile = path.join(dataRoot, 'gateway-provider-keys.keychain.gateway-secret')
  const identity = keychainIdentity(dataRoot)
  let keyring: ProviderCredentialKeyring
  if (fs.existsSync(metadataFile)) {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as {
      version?: number
      service?: string
      account?: string
    }
    if (
      metadata.version !== 1 ||
      metadata.service !== identity.service ||
      metadata.account !== identity.account
    ) {
      throw new Error('Gateway Provider Keychain metadata is invalid')
    }
    const result = runSecurity(runner, [
      'find-generic-password',
      '-s', identity.service,
      '-a', identity.account,
      '-w'
    ])
    if (result.status !== 0) throw new Error('macOS Keychain Provider keyring is unavailable')
    keyring = parseSerialized(
      JSON.parse(String(result.stdout || '').trim()),
      'macOS Keychain'
    )
  } else {
    keyring = newKeyring('macOS Keychain')
  }
  if (options.rotate) keyring = rotatedKeyring(keyring)
  if (options.activeKeyId) keyring = activatedKeyring(keyring, options.activeKeyId)
  if (!fs.existsSync(metadataFile) || options.rotate || options.activeKeyId) {
    const input = Buffer.from(`${JSON.stringify(serialize(keyring))}\n`, 'utf8')
    try {
      const result = runSecurity(runner, [
        'add-generic-password',
        '-U',
        '-s', identity.service,
        '-a', identity.account,
        '-w'
      ], input)
      if (result.status !== 0) throw new Error('macOS Keychain Provider keyring save failed')
    } finally {
      input.fill(0)
    }
    atomicWriteJson(metadataFile, {
      version: 1,
      service: identity.service,
      account: identity.account
    })
  }
  return keyring
}

function rotatedKeyring(current: ProviderCredentialKeyring): ProviderCredentialKeyring {
  if (current.keyIds().length >= MAX_PROVIDER_KEYS) {
    throw new Error(
      `Provider master keyring already contains ${MAX_PROVIDER_KEYS} keys; ` +
      'verify and retire obsolete keys before rotating again'
    )
  }
  const nextId = `provider-key-${randomBytes(8).toString('hex')}`
  const keys = new Map(
    current.keyIds().map(keyId => {
      const key = current.getKey(keyId)
      if (!key) throw new Error(`Provider master key ${keyId} is unavailable`)
      return [keyId, key] as const
    })
  )
  keys.set(nextId, new Uint8Array(randomBytes(32)))
  return new StaticProviderCredentialKeyring(nextId, keys, current.protection)
}

function activatedKeyring(
  current: ProviderCredentialKeyring,
  activeKeyId: string
): ProviderCredentialKeyring {
  if (!validKeyId(activeKeyId) || !current.getKey(activeKeyId)) {
    throw new Error(`Provider rollback key ${activeKeyId} is unavailable`)
  }
  const keys = new Map(
    current.keyIds().map(keyId => {
      const key = current.getKey(keyId)
      if (!key) throw new Error(`Provider master key ${keyId} is unavailable`)
      return [keyId, key] as const
    })
  )
  return new StaticProviderCredentialKeyring(activeKeyId, keys, current.protection)
}

function deterministicTestKeyring(dataRoot: string): ProviderCredentialKeyring {
  const key = crypto.createHash('sha256')
    .update('ai-editor-gateway-provider-test-key-v1\0', 'utf8')
    .update(path.resolve(dataRoot), 'utf8')
    .digest()
  return new StaticProviderCredentialKeyring(
    'provider-test-key-v1',
    new Map([['provider-test-key-v1', new Uint8Array(key)]]),
    'deterministic-test-only'
  )
}

export function loadProviderCredentialKeyring(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform
    runner?: ProcessRunner
  } = {}
): ProviderCredentialKeyring {
  const fromEnvironment = environmentKeyring(env)
  if (fromEnvironment) return fromEnvironment
  if (config.environment === 'production') {
    throw new Error(`${PROVIDER_KEYRING_ENV} is required in production`)
  }
  if (config.environment === 'test') {
    return deterministicTestKeyring(config.dataRoot)
  }
  const platform = options.platform || process.platform
  const runner = options.runner || spawnSync as ProcessRunner
  if (platform === 'win32') return loadWindowsKeyring(config.dataRoot, runner)
  if (platform === 'darwin') return loadMacKeyring(config.dataRoot, runner)
  throw new Error(
    `Provider master key storage is unsupported on ${platform}; ` +
    `configure ${PROVIDER_KEYRING_ENV} or inject a KMS adapter`
  )
}

export function rotatePlatformProviderCredentialKeyring(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform
    runner?: ProcessRunner
  } = {}
): ProviderCredentialKeyring {
  if (environmentKeyring(env)) {
    throw new Error(
      'Environment/KMS Provider keyrings must be rotated externally, then rewrapped with the CLI'
    )
  }
  if (config.environment === 'production') {
    throw new Error('Production Provider key rotation requires an external environment/KMS update')
  }
  const platform = options.platform || process.platform
  const runner = options.runner || spawnSync as ProcessRunner
  if (platform === 'win32') {
    return loadWindowsKeyring(config.dataRoot, runner, { rotate: true })
  }
  if (platform === 'darwin') {
    return loadMacKeyring(config.dataRoot, runner, { rotate: true })
  }
  throw new Error(`Provider master key rotation is unsupported on ${platform}`)
}

export function activatePlatformProviderCredentialKeyring(
  config: GatewayConfig,
  activeKeyId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform
    runner?: ProcessRunner
  } = {}
): ProviderCredentialKeyring {
  if (environmentKeyring(env)) {
    throw new Error(
      `Environment/KMS Provider rollback must set ${PROVIDER_ACTIVE_KEY_ENV} externally`
    )
  }
  if (config.environment === 'production') {
    throw new Error(
      'Production Provider rollback requires an external environment/KMS update'
    )
  }
  const platform = options.platform || process.platform
  const runner = options.runner || spawnSync as ProcessRunner
  if (platform === 'win32') {
    return loadWindowsKeyring(config.dataRoot, runner, { activeKeyId })
  }
  if (platform === 'darwin') {
    return loadMacKeyring(config.dataRoot, runner, { activeKeyId })
  }
  throw new Error(`Provider master key rollback is unsupported on ${platform}`)
}
