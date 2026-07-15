const secretKey = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|ticket|nonce|codeVerifier|invitationCode)/i
const bearer = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const commonAssignment = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=([^&\s]+)/gi

export function redactText(value: string): string {
  return value
    .replace(bearer, 'Bearer [REDACTED]')
    .replace(commonAssignment, '$1=[REDACTED]')
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretKey.test(key) ? '[REDACTED]' : redactValue(item, seen)
    ])
  )
}
