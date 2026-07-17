import { randomBytes, randomUUID } from 'node:crypto'

export type IdPrefix =
  | 'req'
  | 'err'
  | 'acct'
  | 'org'
  | 'ds'
  | 'rt'
  | 'atx'
  | 'lh'
  | 'wv'
  | 'turn'
  | 'usage'
  | 'provider'
  | 'cred'
  | 'route'
  | 'audit'
  | 'oauth'

export interface IdSource {
  opaque(prefix: IdPrefix): string
  secret(bytes?: number): string
}

export class CryptoIdSource implements IdSource {
  opaque(prefix: IdPrefix): string {
    return `${prefix}_${randomUUID().replaceAll('-', '')}`
  }

  secret(bytes = 32): string {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
      throw new Error('Secret entropy must be between 16 and 128 bytes')
    }
    return randomBytes(bytes).toString('base64url')
  }
}

export class SequenceIdSource implements IdSource {
  #next = 0

  opaque(prefix: IdPrefix): string {
    this.#next += 1
    return `${prefix}_test_${String(this.#next).padStart(4, '0')}`
  }

  secret(bytes = 32): string {
    this.#next += 1
    const prefix = `test-secret-${String(this.#next).padStart(4, '0')}-`
    return `${prefix}${'x'.repeat(Math.max(bytes, 16))}`
  }
}
