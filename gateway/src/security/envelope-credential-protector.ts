import crypto from 'node:crypto'
import type {
  CredentialKeyProvider,
  WrappedDataKey
} from './credential-keys.js'

const ENVELOPE_VERSION = 1
const DATA_KEY_BYTES = 32
const NONCE_BYTES = 12

export interface CredentialIdentity {
  readonly id: string
  readonly providerId: string
  readonly credentialVersion: number
}

export interface StoredCredentialSecret {
  readonly storageKind: 'envelope-v1'
  readonly keyVersion: string
  readonly secretPayload: string
}

interface EnvelopeV1 {
  readonly version: 1
  readonly algorithm: 'A256GCM'
  readonly aadVersion: 1
  readonly credentialVersion: number
  readonly keyVersion: string
  readonly wrappedDataKey: WrappedDataKey
  readonly payload: {
    readonly nonce: string
    readonly ciphertext: string
    readonly tag: string
  }
}

export interface CredentialProtector {
  protect(
    identity: CredentialIdentity,
    plaintext: string
  ): Promise<StoredCredentialSecret>
  reveal(
    identity: CredentialIdentity,
    stored: {
      readonly storageKind: 'envelope-v1'
      readonly keyVersion: string | null
      readonly secretPayload: string
    }
  ): Promise<string>
  rewrap(
    identity: CredentialIdentity,
    stored: {
      readonly storageKind: 'envelope-v1'
      readonly keyVersion: string | null
      readonly secretPayload: string
    }
  ): Promise<StoredCredentialSecret>
  currentKeyVersion(): Promise<string>
}

function aad(identity: CredentialIdentity, purpose: 'payload' | 'dek'): Buffer {
  return Buffer.from([
    'aieditor-envelope-v1',
    identity.id,
    identity.providerId,
    'global',
    'provider-secret',
    String(identity.credentialVersion),
    purpose
  ].join('\n'), 'utf8')
}

function decode(value: string, expectedLength: number | null, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
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

function parseEnvelope(value: string): EnvelopeV1 {
  let parsed: Partial<EnvelopeV1>
  try {
    parsed = JSON.parse(value) as Partial<EnvelopeV1>
  } catch (error) {
    throw new Error('Credential envelope is not valid JSON', { cause: error })
  }
  if (
    parsed.version !== ENVELOPE_VERSION ||
    parsed.algorithm !== 'A256GCM' ||
    parsed.aadVersion !== 1 ||
    !Number.isSafeInteger(parsed.credentialVersion) ||
    Number(parsed.credentialVersion) < 1 ||
    typeof parsed.keyVersion !== 'string' ||
    !parsed.wrappedDataKey ||
    parsed.wrappedDataKey.keyVersion !== parsed.keyVersion ||
    !parsed.payload ||
    typeof parsed.payload.nonce !== 'string' ||
    typeof parsed.payload.ciphertext !== 'string' ||
    typeof parsed.payload.tag !== 'string'
  ) {
    throw new Error('Credential envelope metadata is invalid')
  }
  return parsed as EnvelopeV1
}

export class EnvelopeCredentialProtector implements CredentialProtector {
  constructor(private readonly keys: CredentialKeyProvider) {}

  currentKeyVersion(): Promise<string> {
    return this.keys.currentKeyVersion()
  }

  async protect(
    identity: CredentialIdentity,
    plaintext: string
  ): Promise<StoredCredentialSecret> {
    if (typeof plaintext !== 'string' || !plaintext) {
      throw new Error('Credential plaintext is required')
    }
    const dataKey = crypto.randomBytes(DATA_KEY_BYTES)
    const nonce = crypto.randomBytes(NONCE_BYTES)
    const payloadAad = aad(identity, 'payload')
    const dataKeyAad = aad(identity, 'dek')
    const plaintextBytes = Buffer.from(plaintext, 'utf8')
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, nonce)
      cipher.setAAD(payloadAad)
      const ciphertext = Buffer.concat([
        cipher.update(plaintextBytes),
        cipher.final()
      ])
      const tag = cipher.getAuthTag()
      const wrappedDataKey = await this.keys.wrapDataKey(dataKey, dataKeyAad)
      const envelope: EnvelopeV1 = {
        version: ENVELOPE_VERSION,
        algorithm: 'A256GCM',
        aadVersion: 1,
        credentialVersion: identity.credentialVersion,
        keyVersion: wrappedDataKey.keyVersion,
        wrappedDataKey,
        payload: {
          nonce: nonce.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          tag: tag.toString('base64')
        }
      }
      try {
        return {
          storageKind: 'envelope-v1',
          keyVersion: envelope.keyVersion,
          secretPayload: JSON.stringify(envelope)
        }
      } finally {
        ciphertext.fill(0)
        tag.fill(0)
      }
    } finally {
      dataKey.fill(0)
      nonce.fill(0)
      payloadAad.fill(0)
      dataKeyAad.fill(0)
      plaintextBytes.fill(0)
    }
  }

  async reveal(
    identity: CredentialIdentity,
    stored: {
      readonly storageKind: 'envelope-v1'
      readonly keyVersion: string | null
      readonly secretPayload: string
    }
  ): Promise<string> {
    const envelope = parseEnvelope(stored.secretPayload)
    if (
      envelope.credentialVersion !== identity.credentialVersion ||
      stored.keyVersion !== envelope.keyVersion
    ) {
      throw new Error('Credential envelope identity does not match its database record')
    }
    const payloadAad = aad(identity, 'payload')
    const dataKeyAad = aad(identity, 'dek')
    const dataKey = Buffer.from(await this.keys.unwrapDataKey(
      envelope.wrappedDataKey,
      dataKeyAad
    ))
    const nonce = decode(envelope.payload.nonce, NONCE_BYTES, 'Credential nonce')
    const ciphertext = decode(
      envelope.payload.ciphertext,
      null,
      'Credential ciphertext'
    )
    const tag = decode(envelope.payload.tag, 16, 'Credential authentication tag')
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, nonce)
      decipher.setAAD(payloadAad)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ])
      try {
        return plaintext.toString('utf8')
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      throw new Error('Credential envelope authentication failed', { cause: error })
    } finally {
      dataKey.fill(0)
      nonce.fill(0)
      ciphertext.fill(0)
      tag.fill(0)
      payloadAad.fill(0)
      dataKeyAad.fill(0)
    }
  }

  async rewrap(
    identity: CredentialIdentity,
    stored: {
      readonly storageKind: 'envelope-v1'
      readonly keyVersion: string | null
      readonly secretPayload: string
    }
  ): Promise<StoredCredentialSecret> {
    const envelope = parseEnvelope(stored.secretPayload)
    if (
      envelope.credentialVersion !== identity.credentialVersion ||
      stored.keyVersion !== envelope.keyVersion
    ) {
      throw new Error('Credential envelope identity does not match its database record')
    }
    const current = await this.keys.currentKeyVersion()
    if (current === envelope.keyVersion) {
      return {
        storageKind: 'envelope-v1',
        keyVersion: envelope.keyVersion,
        secretPayload: stored.secretPayload
      }
    }
    const dataKeyAad = aad(identity, 'dek')
    const dataKey = Buffer.from(await this.keys.unwrapDataKey(
      envelope.wrappedDataKey,
      dataKeyAad
    ))
    try {
      const wrappedDataKey = await this.keys.wrapDataKey(dataKey, dataKeyAad)
      return {
        storageKind: 'envelope-v1',
        keyVersion: wrappedDataKey.keyVersion,
        secretPayload: JSON.stringify({
          ...envelope,
          keyVersion: wrappedDataKey.keyVersion,
          wrappedDataKey
        } satisfies EnvelopeV1)
      }
    } finally {
      dataKey.fill(0)
      dataKeyAad.fill(0)
    }
  }
}
