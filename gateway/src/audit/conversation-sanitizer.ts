export const CONVERSATION_REDACTION_VERSION = 1
export const MAX_CONVERSATION_TEXT_LENGTH = 16_384

const bearerSecret = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const openAiSecret = /\bsk-[A-Za-z0-9_-]{12,}\b/g
const githubSecret = /\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi
const awsAccessKey = /\bAKIA[0-9A-Z]{16}\b/g
const jwtSecret = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const secretAssignment =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalized(value: string): string {
  return value
    .replaceAll('\0', '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

export function sanitizeConversationText(value: string): string {
  const sanitized = normalized(value)
    .replace(bearerSecret, 'Bearer [REDACTED]')
    .replace(openAiSecret, '[REDACTED]')
    .replace(githubSecret, '[REDACTED]')
    .replace(awsAccessKey, '[REDACTED]')
    .replace(jwtSecret, '[REDACTED]')
    .replace(secretAssignment, (_match, name: string, separator: string) =>
      `${name}${separator}[REDACTED]`
    )
  if (sanitized.length <= MAX_CONVERSATION_TEXT_LENGTH) return sanitized
  return sanitized.slice(0, MAX_CONVERSATION_TEXT_LENGTH - 14) + '\n[TRUNCATED]'
}

function allowedContentText(value: unknown, allowedTypes: ReadonlySet<string>): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      result.push(item)
      continue
    }
    const part = record(item)
    if (!part || !allowedTypes.has(String(part['type'] || ''))) continue
    if (typeof part['text'] === 'string') result.push(part['text'])
  }
  return result
}

export function extractUserText(body: unknown): string | null {
  const request = record(body)
  if (!request) return null
  const values: string[] = []
  if (typeof request['input'] === 'string') {
    values.push(request['input'])
  } else if (Array.isArray(request['input'])) {
    for (const item of request['input']) {
      const message = record(item)
      if (!message || message['role'] !== 'user') continue
      values.push(...allowedContentText(
        message['content'],
        new Set(['input_text', 'text'])
      ))
    }
  }
  if (Array.isArray(request['messages'])) {
    for (const item of request['messages']) {
      const message = record(item)
      if (!message || message['role'] !== 'user') continue
      values.push(...allowedContentText(
        message['content'],
        new Set(['text', 'input_text'])
      ))
    }
  }
  const joined = values.map(normalized).filter(Boolean).join('\n\n')
  return joined ? sanitizeConversationText(joined) : null
}

function assistantMessageText(value: unknown): string[] {
  const message = record(value)
  if (!message || message['role'] !== 'assistant') return []
  return allowedContentText(
    message['content'],
    new Set(['output_text', 'text'])
  )
}

export function extractAssistantText(value: unknown): string | null {
  const root = record(value)
  if (!root) return null
  if (root['response']) {
    const nested = extractAssistantText(root['response'])
    if (nested) return nested
  }
  const values: string[] = []
  if (Array.isArray(root['output'])) {
    for (const item of root['output']) values.push(...assistantMessageText(item))
  }
  if (Array.isArray(root['choices'])) {
    for (const choiceValue of root['choices']) {
      const choice = record(choiceValue)
      if (!choice) continue
      values.push(...assistantMessageText(choice['message']))
    }
  }
  if (
    (root['type'] === 'response.output_text.done' ||
      root['type'] === 'response.output_text.completed') &&
    typeof root['text'] === 'string'
  ) {
    values.push(root['text'])
  }
  const joined = values.map(normalized).filter(Boolean).join('\n\n')
  return joined ? sanitizeConversationText(joined) : null
}

export function extractAssistantTextFromEvents(events: readonly unknown[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const full = extractAssistantText(events[index])
    if (full) return full
  }
  const deltas: string[] = []
  for (const eventValue of events) {
    const event = record(eventValue)
    if (!event) continue
    if (
      event['type'] === 'response.output_text.delta' &&
      typeof event['delta'] === 'string'
    ) {
      deltas.push(event['delta'])
      continue
    }
    if (!Array.isArray(event['choices'])) continue
    for (const choiceValue of event['choices']) {
      const choice = record(choiceValue)
      const delta = record(choice?.['delta'])
      if (typeof delta?.['content'] === 'string') deltas.push(delta['content'])
    }
  }
  const joined = deltas.join('')
  return joined ? sanitizeConversationText(joined) : null
}
