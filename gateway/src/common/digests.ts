import { createHmac, timingSafeEqual } from 'node:crypto'

export interface KeyedDigest {
  digest(namespace: string, value: string): string
  matches(namespace: string, value: string, expected: string): boolean
}

export class HmacSha256Digest implements KeyedDigest {
  readonly #key: Buffer

  constructor(key: Buffer | string) {
    this.#key = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(key, 'utf8')
    if (this.#key.length < 32) throw new Error('Digest key must contain at least 32 bytes')
  }

  digest(namespace: string, value: string): string {
    if (!/^[a-z0-9-]{1,40}$/i.test(namespace)) throw new Error('Invalid digest namespace')
    return createHmac('sha256', this.#key)
      .update(namespace)
      .update('\0')
      .update(value)
      .digest('base64url')
  }

  matches(namespace: string, value: string, expected: string): boolean {
    const actual = Buffer.from(this.digest(namespace, value))
    const wanted = Buffer.from(expected)
    return actual.length === wanted.length && timingSafeEqual(actual, wanted)
  }
}
