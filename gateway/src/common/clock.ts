export interface Clock {
  now(): Date
  nowMs(): number
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }

  nowMs(): number {
    return Date.now()
  }
}

export class FixedClock implements Clock {
  readonly #instant: Date

  constructor(value: string | number | Date) {
    this.#instant = new Date(value)
    if (!Number.isFinite(this.#instant.getTime())) throw new Error('FixedClock requires a valid instant')
  }

  now(): Date {
    return new Date(this.#instant)
  }

  nowMs(): number {
    return this.#instant.getTime()
  }
}
