import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const KEY_FILE_VERSION = 1
const VAULT_VERSION = 1
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,160}$/
const KEY_VERSION = /^[A-Za-z0-9._:-]{1,120}$/
const SECRET_FIELDS = [
  'access_token',
  'refresh_token',
  'id_token',
  'expires_at'
]

function decode(value, expectedLength, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  const result = Buffer.from(value, 'base64')
  if (
    (expectedLength !== null && result.length !== expectedLength) ||
    result.toString('base64') !== value
  ) {
    result.fill(0)
    throw new Error(`${name} is invalid`)
  }
  return result
}

function atomicWrite(file, value) {
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

function keyFile(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== KEY_FILE_VERSION ||
    !KEY_VERSION.test(String(value.currentKeyVersion || '')) ||
    !value.keys ||
    typeof value.keys !== 'object' ||
    Array.isArray(value.keys) ||
    !value.keys[value.currentKeyVersion] ||
    Object.keys(value.keys).length < 1 ||
    Object.keys(value.keys).length > 32 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('Provider Worker credential key file is invalid')
  }
  for (const [version, encoded] of Object.entries(value.keys)) {
    if (!KEY_VERSION.test(version)) {
      throw new Error('Provider Worker credential key version is invalid')
    }
    const key = decode(encoded, KEY_BYTES, `Provider Worker key ${version}`)
    key.fill(0)
  }
  return value
}

function createKeyVersion() {
  return `dev-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`
}

function credentialVersion(account) {
  const value = Number(account.credential_version)
  return Number.isSafeInteger(value) && value >= 1 ? value : 1
}

function aad(options, credentialId, version, purpose) {
  return Buffer.from([
    'aieditor-worker-credential-v1',
    options.workerId,
    options.region,
    credentialId,
    String(version),
    'chatgpt-sub',
    purpose
  ].join('\n'), 'utf8')
}

function safeSecrets(account) {
  const value = {}
  for (const field of SECRET_FIELDS) {
    if (account[field] !== undefined && account[field] !== null) {
      value[field] = account[field]
    }
  }
  return value
}

function parseVault(value, options, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== VAULT_VERSION ||
    value.workerId !== options.workerId ||
    value.region !== options.region ||
    !Array.isArray(value.records) ||
    value.records.length > 500 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('Provider Worker credential vault metadata is invalid')
  }
  const ids = new Set()
  for (const record of value.records) {
    if (
      !record ||
      typeof record !== 'object' ||
      !OPAQUE_ID.test(String(record.id || '')) ||
      ids.has(record.id) ||
      !Number.isSafeInteger(record.credentialVersion) ||
      record.credentialVersion < 1 ||
      !KEY_VERSION.test(String(record.keyVersion || '')) ||
      !keys[record.keyVersion] ||
      !record.wrappedDataKey ||
      record.wrappedDataKey.keyVersion !== record.keyVersion ||
      record.wrappedDataKey.algorithm !== 'A256GCM' ||
      !record.payload ||
      record.payload.algorithm !== 'A256GCM' ||
      typeof record.wrappedDataKey.nonce !== 'string' ||
      typeof record.wrappedDataKey.ciphertext !== 'string' ||
      typeof record.wrappedDataKey.tag !== 'string' ||
      typeof record.payload.nonce !== 'string' ||
      typeof record.payload.ciphertext !== 'string' ||
      record.payload.ciphertext.length > 1024 * 1024 ||
      typeof record.payload.tag !== 'string'
    ) {
      throw new Error('Provider Worker credential vault record is invalid')
    }
    const encodedFields = [
      [record.wrappedDataKey.nonce, NONCE_BYTES, 'Provider Worker wrapped-key nonce'],
      [record.wrappedDataKey.ciphertext, KEY_BYTES, 'Provider Worker wrapped key'],
      [record.wrappedDataKey.tag, 16, 'Provider Worker wrapped-key tag'],
      [record.payload.nonce, NONCE_BYTES, 'Provider Worker payload nonce'],
      [record.payload.ciphertext, null, 'Provider Worker ciphertext'],
      [record.payload.tag, 16, 'Provider Worker payload tag']
    ]
    for (const [encoded, expectedLength, name] of encodedFields) {
      const field = decode(encoded, expectedLength, name)
      field.fill(0)
    }
    ids.add(record.id)
  }
  return value
}

export class DevelopmentWorkerCredentialVault {
  constructor(options) {
    this.options = options
    this.keyFilePath = path.join(
      options.dataRoot,
      'provider-worker-credential-master-keys.worker-secret'
    )
    this.vaultFile = path.join(
      options.dataRoot,
      'provider-worker-chatgpt-credentials-v1.json'
    )
    if (fs.existsSync(this.keyFilePath)) {
      this.keys = keyFile(JSON.parse(fs.readFileSync(this.keyFilePath, 'utf8')))
    } else {
      const version = createKeyVersion()
      this.keys = {
        version: KEY_FILE_VERSION,
        currentKeyVersion: version,
        keys: {
          [version]: crypto.randomBytes(KEY_BYTES).toString('base64')
        },
        updatedAt: new Date().toISOString()
      }
      atomicWrite(this.keyFilePath, this.keys)
    }
    this.records = fs.existsSync(this.vaultFile)
      ? parseVault(
          JSON.parse(fs.readFileSync(this.vaultFile, 'utf8')),
          options,
          this.keys.keys
        )
        .records
      : []
  }

  async currentKeyVersion() {
    return this.keys.currentKeyVersion
  }

  async rotate() {
    if (Object.keys(this.keys.keys).length >= 32) {
      throw new Error(
        'Provider Worker key ring is full; retire an unused key before rotating'
      )
    }
    const version = createKeyVersion()
    this.keys = {
      ...this.keys,
      currentKeyVersion: version,
      keys: {
        ...this.keys.keys,
        [version]: crypto.randomBytes(KEY_BYTES).toString('base64')
      },
      updatedAt: new Date().toISOString()
    }
    atomicWrite(this.keyFilePath, this.keys)
    const accounts = await this.restore(this.records.map(record => ({
      id: record.id,
      credential_version: record.credentialVersion
    })))
    await this.snapshot(accounts)
    return version
  }

  async restore(accounts) {
    const records = new Map(this.records.map(record => [record.id, record]))
    const result = []
    for (const account of accounts) {
      const record = records.get(account.id)
      if (!record || record.credentialVersion !== credentialVersion(account)) {
        result.push({ ...account })
        continue
      }
      const secrets = this.#decrypt(record)
      result.push({ ...account, ...secrets })
    }
    return result
  }

  async snapshot(accounts) {
    const records = []
    for (const account of accounts) {
      if (!OPAQUE_ID.test(String(account.id || ''))) {
        throw new Error('Provider Worker credential account ID is invalid')
      }
      records.push(this.#encrypt(
        account.id,
        credentialVersion(account),
        safeSecrets(account)
      ))
    }
    this.records = records
    atomicWrite(this.vaultFile, {
      schemaVersion: VAULT_VERSION,
      workerId: this.options.workerId,
      region: this.options.region,
      records,
      updatedAt: new Date().toISOString()
    })
  }

  #encrypt(id, version, secrets) {
    const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8')
    const dataKey = crypto.randomBytes(KEY_BYTES)
    const payloadNonce = crypto.randomBytes(NONCE_BYTES)
    const wrapNonce = crypto.randomBytes(NONCE_BYTES)
    const payloadAad = aad(this.options, id, version, 'payload')
    const wrapAad = aad(this.options, id, version, 'dek')
    const keyVersion = this.keys.currentKeyVersion
    const masterKey = decode(
      this.keys.keys[keyVersion],
      KEY_BYTES,
      `Provider Worker key ${keyVersion}`
    )
    try {
      const payloadCipher = crypto.createCipheriv(
        'aes-256-gcm',
        dataKey,
        payloadNonce
      )
      payloadCipher.setAAD(payloadAad)
      const ciphertext = Buffer.concat([
        payloadCipher.update(plaintext),
        payloadCipher.final()
      ])
      const payloadTag = payloadCipher.getAuthTag()
      const wrapCipher = crypto.createCipheriv(
        'aes-256-gcm',
        masterKey,
        wrapNonce
      )
      wrapCipher.setAAD(wrapAad)
      const wrappedKey = Buffer.concat([
        wrapCipher.update(dataKey),
        wrapCipher.final()
      ])
      const wrapTag = wrapCipher.getAuthTag()
      try {
        return {
          id,
          credentialVersion: version,
          keyVersion,
          wrappedDataKey: {
            algorithm: 'A256GCM',
            keyVersion,
            nonce: wrapNonce.toString('base64'),
            ciphertext: wrappedKey.toString('base64'),
            tag: wrapTag.toString('base64')
          },
          payload: {
            algorithm: 'A256GCM',
            nonce: payloadNonce.toString('base64'),
            ciphertext: ciphertext.toString('base64'),
            tag: payloadTag.toString('base64')
          }
        }
      } finally {
        ciphertext.fill(0)
        payloadTag.fill(0)
        wrappedKey.fill(0)
        wrapTag.fill(0)
      }
    } finally {
      plaintext.fill(0)
      dataKey.fill(0)
      payloadNonce.fill(0)
      wrapNonce.fill(0)
      payloadAad.fill(0)
      wrapAad.fill(0)
      masterKey.fill(0)
    }
  }

  #decrypt(record) {
    const masterKey = decode(
      this.keys.keys[record.keyVersion],
      KEY_BYTES,
      `Provider Worker key ${record.keyVersion}`
    )
    const wrapNonce = decode(
      record.wrappedDataKey.nonce,
      NONCE_BYTES,
      'Provider Worker wrapped-key nonce'
    )
    const wrappedKey = decode(
      record.wrappedDataKey.ciphertext,
      KEY_BYTES,
      'Provider Worker wrapped key'
    )
    const wrapTag = decode(
      record.wrappedDataKey.tag,
      16,
      'Provider Worker wrapped-key tag'
    )
    const payloadNonce = decode(
      record.payload.nonce,
      NONCE_BYTES,
      'Provider Worker payload nonce'
    )
    const ciphertext = decode(
      record.payload.ciphertext,
      null,
      'Provider Worker ciphertext'
    )
    const payloadTag = decode(
      record.payload.tag,
      16,
      'Provider Worker payload tag'
    )
    const payloadAad = aad(
      this.options,
      record.id,
      record.credentialVersion,
      'payload'
    )
    const wrapAad = aad(
      this.options,
      record.id,
      record.credentialVersion,
      'dek'
    )
    let dataKey = Buffer.alloc(0)
    try {
      const unwrap = crypto.createDecipheriv(
        'aes-256-gcm',
        masterKey,
        wrapNonce
      )
      unwrap.setAAD(wrapAad)
      unwrap.setAuthTag(wrapTag)
      dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()])
      if (dataKey.length !== KEY_BYTES) {
        throw new Error('Provider Worker data key length is invalid')
      }
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        dataKey,
        payloadNonce
      )
      decipher.setAAD(payloadAad)
      decipher.setAuthTag(payloadTag)
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ])
      try {
        const value = JSON.parse(plaintext.toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Provider Worker credential plaintext is invalid')
        }
        return safeSecrets(value)
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      throw new Error('Provider Worker credential authentication failed', {
        cause: error
      })
    } finally {
      masterKey.fill(0)
      wrapNonce.fill(0)
      wrappedKey.fill(0)
      wrapTag.fill(0)
      payloadNonce.fill(0)
      ciphertext.fill(0)
      payloadTag.fill(0)
      payloadAad.fill(0)
      wrapAad.fill(0)
      dataKey.fill(0)
    }
  }
}

export function loadWorkerCredentialVault(config) {
  if (config.environment === 'production') {
    throw new Error(
      'Production Provider Worker requires an injected KMS/Secret Manager credential vault'
    )
  }
  return new DevelopmentWorkerCredentialVault({
    dataRoot: config.dataRoot,
    workerId: config.workerId,
    region: config.region
  })
}
