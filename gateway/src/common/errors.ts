export interface SafeErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly requestId: string
    readonly retryable: boolean
  }
}

export class SafeError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(options: {
    code: string
    message: string
    statusCode: number
    retryable?: boolean
    retryAfterMs?: number
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = 'SafeError'
    this.code = options.code
    this.statusCode = options.statusCode
    this.retryable = options.retryable === true
    if (
      Number.isFinite(options.retryAfterMs) &&
      Number(options.retryAfterMs) > 0
    ) {
      this.retryAfterMs = Number(options.retryAfterMs)
    }
  }
}

export function toSafeError(error: unknown): SafeError {
  if (error instanceof SafeError) return error
  return new SafeError({
    code: 'internal_error',
    message: '服务暂时不可用，请稍后重试。',
    statusCode: 500,
    retryable: true,
    cause: error
  })
}

export function safeErrorBody(error: unknown, requestId: string): SafeErrorBody {
  const safe = toSafeError(error)
  return {
    error: {
      code: safe.code,
      message: safe.message,
      requestId,
      retryable: safe.retryable
    }
  }
}
