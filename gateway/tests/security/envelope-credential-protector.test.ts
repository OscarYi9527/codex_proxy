import {
  StaticCredentialKeyProvider
} from '../../src/security/credential-keys.js'
import {
  EnvelopeCredentialProtector
} from '../../src/security/envelope-credential-protector.js'

describe('AES-256-GCM Provider credential envelopes (T136)', () => {
  const identity = {
    id: 'cred_envelope_test',
    providerId: 'provider_envelope_test',
    credentialVersion: 1
  }

  it('authenticates ciphertext, nonce, tag, wrapped DEK and record identity', async () => {
    const keys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-test-v1',
      keys: {
        'kms-test-v1': new Uint8Array(32).fill(17)
      }
    })
    const protector = new EnvelopeCredentialProtector(keys)
    const secret = 'sk-test-envelope-secret-never-store-plaintext'
    const stored = await protector.protect(identity, secret)
    expect(stored.storageKind).toBe('envelope-v1')
    expect(stored.keyVersion).toBe('kms-test-v1')
    expect(stored.secretPayload).not.toContain(secret)
    await expect(protector.reveal(identity, stored)).resolves.toBe(secret)

    const envelope = JSON.parse(stored.secretPayload)
    const tamperedValues = [
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          ciphertext: Buffer.from('tampered').toString('base64')
        }
      },
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          nonce: Buffer.alloc(12, 3).toString('base64')
        }
      },
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          tag: Buffer.alloc(16, 4).toString('base64')
        }
      },
      {
        ...envelope,
        wrappedDataKey: {
          ...envelope.wrappedDataKey,
          ciphertext: Buffer.alloc(32, 5).toString('base64')
        }
      }
    ]
    for (const value of tamperedValues) {
      await expect(protector.reveal(identity, {
        ...stored,
        secretPayload: JSON.stringify(value)
      })).rejects.toThrow()
    }
    await expect(protector.reveal({
      ...identity,
      providerId: 'provider_tampered'
    }, stored)).rejects.toThrow()
    await expect(protector.reveal({
      ...identity,
      credentialVersion: 2
    }, stored)).rejects.toThrow()
  })

  it('rewraps only the DEK during master-key rotation', async () => {
    const keys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-test-v1',
      keys: {
        'kms-test-v1': new Uint8Array(32).fill(23),
        'kms-test-v2': new Uint8Array(32).fill(29)
      }
    })
    const protector = new EnvelopeCredentialProtector(keys)
    const original = await protector.protect(identity, 'rotation-secret')
    const originalEnvelope = JSON.parse(original.secretPayload)

    keys.setCurrentVersion('kms-test-v2')
    const rotated = await protector.rewrap(identity, original)
    const rotatedEnvelope = JSON.parse(rotated.secretPayload)

    expect(rotated.keyVersion).toBe('kms-test-v2')
    expect(rotatedEnvelope.payload).toEqual(originalEnvelope.payload)
    expect(rotatedEnvelope.wrappedDataKey).not.toEqual(
      originalEnvelope.wrappedDataKey
    )
    await expect(protector.reveal(identity, original))
      .resolves.toBe('rotation-secret')
    await expect(protector.reveal(identity, rotated))
      .resolves.toBe('rotation-secret')
  })
})
