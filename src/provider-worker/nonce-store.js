export class NonceStore {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.ttlMs = options.ttlMs || 2 * 60_000
    this.entries = new Map()
  }

  consume(gatewayId, nonce) {
    this.cleanup()
    const key = `${gatewayId}:${nonce}`
    if (this.entries.has(key)) return false
    this.entries.set(key, this.now() + this.ttlMs)
    return true
  }

  cleanup() {
    const now = this.now()
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key)
    }
  }
}
