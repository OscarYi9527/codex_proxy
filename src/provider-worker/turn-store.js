export class TurnStore {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.ttlMs = options.ttlMs || 15 * 60_000
    this.turns = new Map()
  }

  begin(turnId, fingerprint) {
    this.cleanup()
    const existing = this.turns.get(turnId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { state: 'conflict', turn: existing }
      if (existing.state === 'completed') return { state: 'replay', turn: existing }
      return { state: 'running', turn: existing }
    }
    const turn = {
      turnId,
      fingerprint,
      state: 'running',
      createdAt: this.now(),
      updatedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      abortController: new AbortController(),
      response: null,
      usage: null,
      providerId: null,
      errorCode: null
    }
    this.turns.set(turnId, turn)
    return { state: 'started', turn }
  }

  complete(turnId, result) {
    const turn = this.turns.get(turnId)
    if (!turn || turn.state !== 'running') return false
    turn.state = 'completed'
    turn.response = Buffer.from(result.response)
    turn.usage = result.usage || null
    turn.providerId = result.providerId || null
    turn.updatedAt = this.now()
    turn.expiresAt = this.now() + this.ttlMs
    return true
  }

  fail(turnId, code) {
    const turn = this.turns.get(turnId)
    if (!turn) return
    if (turn.state === 'cancelled') return
    turn.state = 'failed'
    turn.errorCode = code
    turn.updatedAt = this.now()
    turn.expiresAt = this.now() + this.ttlMs
  }

  cancel(turnId) {
    const turn = this.turns.get(turnId)
    if (!turn) return null
    if (turn.state === 'running') {
      turn.abortController.abort()
      turn.state = 'cancelled'
      turn.updatedAt = this.now()
      turn.expiresAt = this.now() + this.ttlMs
    }
    return turn
  }

  get(turnId) {
    this.cleanup()
    return this.turns.get(turnId) || null
  }

  cleanup() {
    const now = this.now()
    for (const [turnId, turn] of this.turns) {
      if (turn.expiresAt <= now) {
        turn.response?.fill(0)
        this.turns.delete(turnId)
      }
    }
  }

  close() {
    for (const turn of this.turns.values()) {
      if (turn.state === 'running') turn.abortController.abort()
      turn.response?.fill(0)
    }
    this.turns.clear()
  }
}
