import { redactSecretText } from '../../../src/secret-scan.js'

const secretKey = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|ticket|nonce|codeVerifier|invitationCode|redeemRequestId|secretPayload)/i

export function redactText(value: string): string {
  return redactSecretText(value)
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...('code' in value && typeof value.code === 'string'
        ? { code: redactText(value.code) }
        : {}),
      ...(value.cause === undefined
        ? {}
        : { cause: redactValue(value.cause, seen) })
    }
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretKey.test(key) ? '[REDACTED]' : redactValue(item, seen)
    ])
  )
}
