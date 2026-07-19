// Cross-provider tool-call identifier normalization.

import crypto from 'crypto'

const RESPONSES_FUNCTION_CALL_ID_MAX_LENGTH = 64

function generatedSuffix() {
  return crypto.randomBytes(16).toString('hex')
}

function boundedFunctionCallId(value) {
  const source = String(value || '').trim()
  if (!source) return `fc_${generatedSuffix()}`

  const sanitized = source.replace(/[^A-Za-z0-9_-]/g, '_')
  const candidate = sanitized.startsWith('fc_') ? sanitized : `fc_${sanitized}`
  if (candidate.length <= RESPONSES_FUNCTION_CALL_ID_MAX_LENGTH) return candidate

  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)
  const available = RESPONSES_FUNCTION_CALL_ID_MAX_LENGTH - 'fc__'.length - hash.length
  const readable = sanitized.replace(/^fc_/, '').slice(0, Math.max(0, available))
  return `fc_${readable}_${hash}`
}

export function responsesFunctionCallItemId(value) {
  return boundedFunctionCallId(value)
}

export function normalizeResponsesFunctionCallIds(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return body

  let changed = false
  const input = body.input.map(item => {
    if (!item || typeof item !== 'object' || item.type !== 'function_call') return item

    const originalId = typeof item.id === 'string' ? item.id : ''
    const originalCallId = typeof item.call_id === 'string' ? item.call_id : ''
    const callId = originalCallId || originalId || `call_${generatedSuffix()}`
    const itemId = responsesFunctionCallItemId(originalId || callId)
    if (itemId === originalId && callId === originalCallId) return item

    changed = true
    return {
      ...item,
      id: itemId,
      call_id: callId
    }
  })

  return changed ? { ...body, input } : body
}
