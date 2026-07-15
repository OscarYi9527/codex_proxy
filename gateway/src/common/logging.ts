import type { Clock } from './clock.js'
import { SystemClock } from './clock.js'
import { redactValue } from './redaction.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  readonly timestamp: string
  readonly level: LogLevel
  readonly event: string
  readonly fields: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

export class SafeLogger {
  readonly #sink: LogSink
  readonly #clock: Clock

  constructor(options: { sink?: LogSink; clock?: Clock } = {}) {
    this.#sink = options.sink || (record => console.log(JSON.stringify(record)))
    this.#clock = options.clock || new SystemClock()
  }

  write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    this.#sink({
      timestamp: this.#clock.now().toISOString(),
      level,
      event,
      fields: redactValue(fields) as Record<string, unknown>
    })
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.write('info', event, fields)
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.write('warn', event, fields)
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.write('error', event, fields)
  }
}
