import {
  ProviderCredentialVault
} from '../../src/security/provider-credential-vault.js'
import {
  StaticProviderCredentialKeyring
} from '../../src/security/provider-master-key.js'

const context = {
  providerId: 'provider_test',
  credentialId: 'credential_test'
}

function key(value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

function vault(
  activeKeyId = 'key-new',
  keys: ReadonlyMap<string, Uint8Array> = new Map([
    ['key-old', key(1)],
    ['key-new', key(2)]
  ])
): ProviderCredentialVault {
  return new ProviderCredentialVault(
    new StaticProviderCredentialKeyring(activeKeyId, keys)
  )
}

describe('ProviderCredentialVault envelope-v1', () => {
  it('uses randomized AES-256-GCM envelopes without storing plaintext', () => {
    const credentials = vault()
    const secret = 'provider-unit-secret-value'
    const first = credentials.seal(secret, context)
    const second = credentials.seal(secret, context)

    expect(first).not.toBe(second)
    expect(first).not.toContain(secret)
    expect(credentials.open(first, context)).toBe(secret)
    expect(JSON.parse(first)).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      key_id: 'key-new'
    })
  })

  it('authenticates Provider and credential IDs as associated data', () => {
    const credentials = vault()
    const envelope = credentials.seal('aad-bound-secret', context)
    expect(() => credentials.open(envelope, {
      ...context,
      providerId: 'provider_other'
    })).toThrow(/authentication failed/)
    expect(() => credentials.open(envelope, {
      ...context,
      credentialId: 'credential_other'
    })).toThrow(/authentication failed/)
  })

  it('rejects ciphertext, tag and envelope-format tampering', () => {
    const credentials = vault()
    const envelope = JSON.parse(
      credentials.seal('tamper-resistant-secret', context)
    ) as Record<string, string>

    const ciphertext = Buffer.from(envelope['ciphertext'] as string, 'base64')
    ciphertext[0] = (ciphertext[0] as number) ^ 1
    expect(() => credentials.open(JSON.stringify({
      ...envelope,
      ciphertext: ciphertext.toString('base64')
    }), context)).toThrow(/authentication failed/)

    const tag = Buffer.from(envelope['tag'] as string, 'base64')
    tag[0] = (tag[0] as number) ^ 1
    expect(() => credentials.open(JSON.stringify({
      ...envelope,
      tag: tag.toString('base64')
    }), context)).toThrow(/authentication failed/)

    expect(() => credentials.open(JSON.stringify({
      ...envelope,
      nonce: 'not-base64'
    }), context)).toThrow(/nonce is invalid/)
  })

  it('supports active-key rotation, old-key reads and rollback rewrap', () => {
    const keys = new Map([
      ['key-old', key(1)],
      ['key-new', key(2)]
    ])
    const oldVault = vault('key-old', keys)
    const original = oldVault.seal('rotation-secret', context)
    expect(oldVault.envelopeKeyId(original)).toBe('key-old')

    const newVault = vault('key-new', keys)
    expect(newVault.open(original, context)).toBe('rotation-secret')
    const rotated = newVault.rewrap(original, context)
    expect(newVault.envelopeKeyId(rotated)).toBe('key-new')

    const rolledBack = oldVault.rewrap(rotated, context)
    expect(oldVault.envelopeKeyId(rolledBack)).toBe('key-old')
    expect(oldVault.open(rolledBack, context)).toBe('rotation-secret')
  })

  it('fails closed when an envelope key is unavailable', () => {
    const encrypted = vault().seal('missing-key-secret', context)
    const incomplete = vault(
      'key-old',
      new Map([['key-old', key(1)]])
    )
    expect(() => incomplete.open(encrypted, context))
      .toThrow(/key-new is unavailable/)
  })
})
