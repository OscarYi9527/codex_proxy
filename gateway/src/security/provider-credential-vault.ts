import crypto from 'node:crypto'
import type { ProviderCredentialKeyring } from './provider-master-key.js'

export interface ProviderCredentialContext {
  readonly credentialId: string
  readonly providerId: string
}

export interface ProviderCredentialEnvelopeV1 {
  readonly version: 1
  readonly algorithm: 'AES-256-GCM'
  readonly key_id: string
  readonly nonce: string
  readonly ciphertext: string
  readonly tag: string
}

function aad(context: ProviderCredentialContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      'ai-editor:provider-credential:v1',
      context.providerId,
      context.credentialId
    ]),
    'utf8'
  )
}

function decodeCanonicalBase64(value: string, field: string): Buffer {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Provider credential envelope ${field} is invalid`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new Error(`Provider credential envelope ${field} is invalid`)
  }
  return decoded
}

function parseEnvelope(payload: string): ProviderCredentialEnvelopeV1 {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new Error('Provider credential envelope is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider credential envelope is invalid')
  }
  const envelope = value as Partial<ProviderCredentialEnvelopeV1>
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    typeof envelope.key_id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,120}$/.test(envelope.key_id) ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.tag !== 'string'
  ) {
    throw new Error('Provider credential envelope fields are invalid')
  }
  const nonce = decodeCanonicalBase64(envelope.nonce, 'nonce')
  const ciphertext = decodeCanonicalBase64(envelope.ciphertext, 'ciphertext')
  const tag = decodeCanonicalBase64(envelope.tag, 'tag')
  if (nonce.length !== 12 || ciphertext.length < 1 || tag.length !== 16) {
    throw new Error('Provider credential envelope nonce or tag is invalid')
  }
  return envelope as ProviderCredentialEnvelopeV1
}

export class ProviderCredentialVault {
  constructor(private readonly keyring: ProviderCredentialKeyring) {}

  activeKeyId(): string {
    return this.keyring.activeKeyId
  }

  seal(secret: string, context: ProviderCredentialContext): string {
    if (!secret) throw new Error('Provider credential cannot be empty')
    const key = this.keyring.getKey(this.keyring.activeKeyId)
    if (!key) throw new Error('Provider active master key is unavailable')
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(context))
    const plaintext = Buffer.from(secret, 'utf8')
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const envelope: ProviderCredentialEnvelopeV1 = {
        version: 1,
        algorithm: 'AES-256-GCM',
        key_id: this.keyring.activeKeyId,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
      }
      return JSON.stringify(envelope)
    } finally {
      plaintext.fill(0)
    }
  }

  open(payload: string, context: ProviderCredentialContext): string {
    const envelope = parseEnvelope(payload)
    const key = this.keyring.getKey(envelope.key_id)
    if (!key) throw new Error(`Provider master key ${envelope.key_id} is unavailable`)
    let plaintext: Buffer
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.nonce, 'base64')
      )
      decipher.setAAD(aad(context))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ])
    } catch {
      throw new Error('Provider credential envelope authentication failed')
    }
    try {
      return plaintext.toString('utf8')
    } finally {
      plaintext.fill(0)
    }
  }

  envelopeKeyId(payload: string): string {
    return parseEnvelope(payload).key_id
  }

  rewrap(payload: string, context: ProviderCredentialContext): string {
    const secret = this.open(payload, context)
    return this.seal(secret, context)
  }
}
