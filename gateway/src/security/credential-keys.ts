import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GatewayConfig } from '../config.js'

const KEY_FILE_VERSION = 1
const KEY_BYTES = 32
const NONCE_BYTES = 12
const KEY_VERSION = /^[A-Za-z0-9._:-]{1,120}$/

export interface WrappedDataKey {
  readonly algorithm: 'A256GCM'
  readonly keyVersion: string
  readonly nonce: string
  readonly ciphertext: string
  readonly tag: string
}

export interface CredentialKeyProvider {
  readonly kind: 'development-file' | 'external-kms'
  currentKeyVersion(): Promise<string>
  wrapDataKey(dataKey: Uint8Array, aad: Uint8Array): Promise<WrappedDataKey>
  unwrapDataKey(value: WrappedDataKey, aad: Uint8Array): Promise<Uint8Array>
}

interface DevelopmentKeyFile {
  readonly version: 1
  readonly currentKeyVersion: string
  readonly keys: Record<string, string>
  readonly updatedAt: string
}

function decodeKey(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${name} is not valid base64`)
  }
  const key = Buffer.from(value, 'base64')
  if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
    key.fill(0)
    throw new Error(`${name} must decode to 32 bytes`)
  }
  return key
}

function parseKeyFile(value: unknown): DevelopmentKeyFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Credential key file is invalid')
  }
  const source = value as Partial<DevelopmentKeyFile>
  if (
    source.version !== KEY_FILE_VERSION ||
    !KEY_VERSION.test(String(source.currentKeyVersion || '')) ||
    !source.keys ||
    typeof source.keys !== 'object' ||
    Array.isArray(source.keys) ||
    typeof source.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(source.updatedAt))
  ) {
    throw new Error('Credential key file metadata is invalid')
  }
  const entries = Object.entries(source.keys)
  if (
    entries.length < 1 ||
    entries.length > 32 ||
    entries.some(([version]) => !KEY_VERSION.test(version)) ||
    !source.keys[source.currentKeyVersion!]
  ) {
    throw new Error('Credential key file versions are invalid')
  }
  for (const [version, encoded] of entries) {
    const key = decodeKey(encoded, `Credential key ${version}`)
    key.fill(0)
  }
  return source as DevelopmentKeyFile
}

function atomicWrite(file: string, value: DevelopmentKeyFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    fs.renameSync(temporary, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Windows ACLs are inherited from the isolated data directory.
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
  }
}

function createVersion(now = Date.now()): string {
  return `dev-${now}-${crypto.randomBytes(8).toString('hex')}`
}

export class DevelopmentFileCredentialKeyProvider implements CredentialKeyProvider {
  readonly kind = 'development-file' as const
  readonly #file: string
  #keyFile: DevelopmentKeyFile

  constructor(dataRoot: string) {
    this.#file = path.join(
      dataRoot,
      'gateway-credential-master-keys.gateway-secret'
    )
    if (fs.existsSync(this.#file)) {
      this.#keyFile = parseKeyFile(JSON.parse(fs.readFileSync(this.#file, 'utf8')))
      return
    }
    const version = createVersion()
    this.#keyFile = {
      version: KEY_FILE_VERSION,
      currentKeyVersion: version,
      keys: { [version]: crypto.randomBytes(KEY_BYTES).toString('base64') },
      updatedAt: new Date().toISOString()
    }
    atomicWrite(this.#file, this.#keyFile)
  }

  async currentKeyVersion(): Promise<string> {
    return this.#keyFile.currentKeyVersion
  }

  async rotate(): Promise<string> {
    if (Object.keys(this.#keyFile.keys).length >= 32) {
      throw new Error(
        'Credential key ring is full; verify and retire an unused key version before rotating'
      )
    }
    const version = createVersion()
    this.#keyFile = {
      ...this.#keyFile,
      currentKeyVersion: version,
      keys: {
        ...this.#keyFile.keys,
        [version]: crypto.randomBytes(KEY_BYTES).toString('base64')
      },
      updatedAt: new Date().toISOString()
    }
    atomicWrite(this.#file, this.#keyFile)
    return version
  }

  async wrapDataKey(dataKey: Uint8Array, aad: Uint8Array): Promise<WrappedDataKey> {
    const keyVersion = this.#keyFile.currentKeyVersion
    const masterKey = decodeKey(
      this.#keyFile.keys[keyVersion]!,
      `Credential key ${keyVersion}`
    )
    const nonce = crypto.randomBytes(NONCE_BYTES)
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, nonce)
      cipher.setAAD(Buffer.from(aad))
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(dataKey)),
        cipher.final()
      ])
      const tag = cipher.getAuthTag()
      try {
        return {
          algorithm: 'A256GCM',
          keyVersion,
          nonce: nonce.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          tag: tag.toString('base64')
        }
      } finally {
        ciphertext.fill(0)
        tag.fill(0)
      }
    } finally {
      masterKey.fill(0)
      nonce.fill(0)
    }
  }

  async unwrapDataKey(value: WrappedDataKey, aad: Uint8Array): Promise<Uint8Array> {
    if (
      value.algorithm !== 'A256GCM' ||
      !KEY_VERSION.test(value.keyVersion) ||
      !this.#keyFile.keys[value.keyVersion]
    ) {
      throw new Error('Credential wrapped data key metadata is invalid')
    }
    const masterKey = decodeKey(
      this.#keyFile.keys[value.keyVersion]!,
      `Credential key ${value.keyVersion}`
    )
    const nonce = Buffer.from(value.nonce, 'base64')
    const ciphertext = Buffer.from(value.ciphertext, 'base64')
    const tag = Buffer.from(value.tag, 'base64')
    try {
      if (nonce.length !== NONCE_BYTES || tag.length !== 16 || ciphertext.length !== KEY_BYTES) {
        throw new Error('Credential wrapped data key is invalid')
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce)
      decipher.setAAD(Buffer.from(aad))
      decipher.setAuthTag(tag)
      const dataKey = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dataKey.length !== KEY_BYTES) {
        dataKey.fill(0)
        throw new Error('Credential data key has an invalid length')
      }
      try {
        return new Uint8Array(dataKey)
      } finally {
        dataKey.fill(0)
      }
    } catch (error) {
      throw new Error('Credential data key authentication failed', { cause: error })
    } finally {
      masterKey.fill(0)
      nonce.fill(0)
      ciphertext.fill(0)
      tag.fill(0)
    }
  }
}

export class StaticCredentialKeyProvider implements CredentialKeyProvider {
  readonly kind: 'development-file' | 'external-kms'
  #currentVersion: string
  readonly #keys: Map<string, Buffer>

  constructor(options: {
    readonly currentVersion: string
    readonly keys: Readonly<Record<string, Uint8Array>>
    readonly kind?: 'development-file' | 'external-kms'
  }) {
    this.kind = options.kind || 'external-kms'
    this.#currentVersion = options.currentVersion
    this.#keys = new Map(Object.entries(options.keys).map(([version, key]) => [
      version,
      Buffer.from(key)
    ]))
    if (!KEY_VERSION.test(this.#currentVersion) || !this.#keys.has(this.#currentVersion)) {
      throw new Error('Static credential key provider is invalid')
    }
  }

  setCurrentVersion(version: string): void {
    if (!this.#keys.has(version)) throw new Error('Credential key version is unavailable')
    this.#currentVersion = version
  }

  async currentKeyVersion(): Promise<string> {
    return this.#currentVersion
  }

  async wrapDataKey(dataKey: Uint8Array, aad: Uint8Array): Promise<WrappedDataKey> {
    return wrapWithKey(
      this.#keys.get(this.#currentVersion)!,
      this.#currentVersion,
      dataKey,
      aad
    )
  }

  async unwrapDataKey(value: WrappedDataKey, aad: Uint8Array): Promise<Uint8Array> {
    const key = this.#keys.get(value.keyVersion)
    if (!key) throw new Error('Credential key version is unavailable')
    return unwrapWithKey(key, value, aad)
  }
}

function wrapWithKey(
  sourceKey: Uint8Array,
  keyVersion: string,
  dataKey: Uint8Array,
  aad: Uint8Array
): WrappedDataKey {
  const key = Buffer.from(sourceKey)
  const nonce = crypto.randomBytes(NONCE_BYTES)
  try {
    if (key.length !== KEY_BYTES) throw new Error('Credential master key must contain 32 bytes')
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(aad))
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(dataKey)),
      cipher.final()
    ])
    const tag = cipher.getAuthTag()
    try {
      return {
        algorithm: 'A256GCM',
        keyVersion,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: tag.toString('base64')
      }
    } finally {
      ciphertext.fill(0)
      tag.fill(0)
    }
  } finally {
    key.fill(0)
    nonce.fill(0)
  }
}

function unwrapWithKey(
  sourceKey: Uint8Array,
  value: WrappedDataKey,
  aad: Uint8Array
): Uint8Array {
  const key = Buffer.from(sourceKey)
  const nonce = Buffer.from(value.nonce, 'base64')
  const ciphertext = Buffer.from(value.ciphertext, 'base64')
  const tag = Buffer.from(value.tag, 'base64')
  try {
    if (
      key.length !== KEY_BYTES ||
      value.algorithm !== 'A256GCM' ||
      nonce.length !== NONCE_BYTES ||
      ciphertext.length !== KEY_BYTES ||
      tag.length !== 16
    ) {
      throw new Error('Credential wrapped data key is invalid')
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(tag)
    const dataKey = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (dataKey.length !== KEY_BYTES) {
      dataKey.fill(0)
      throw new Error('Credential data key has an invalid length')
    }
    try {
      return new Uint8Array(dataKey)
    } finally {
      dataKey.fill(0)
    }
  } catch (error) {
    throw new Error('Credential data key authentication failed', { cause: error })
  } finally {
    key.fill(0)
    nonce.fill(0)
    ciphertext.fill(0)
    tag.fill(0)
  }
}

export function loadCredentialKeyProvider(
  config: GatewayConfig
): CredentialKeyProvider {
  if (config.environment === 'production') {
    throw new Error(
      'Production Gateway requires an injected KMS/Secret Manager credential key provider'
    )
  }
  return new DevelopmentFileCredentialKeyProvider(config.dataRoot)
}
