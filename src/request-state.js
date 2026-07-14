// Per-turn request state used by Code's interruption-recovery flow.
//
// State is intentionally process-local and short-lived: it contains only
// opaque Code session/turn IDs, routing state, timestamps and HTTP status.
// Never persist prompts, response text, tool output or workspace paths here.

const MAX_ENTRIES = 2000
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const entries = new Map()

function key(sessionId, turnId) {
  return `${sessionId}:${turnId}`
}

function clean(now = Date.now()) {
  for (const [entryKey, entry] of entries) {
    if (now - entry.updatedAt > MAX_AGE_MS) entries.delete(entryKey)
  }
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
}

export function readCodeTurnMetadata(req, body) {
  const candidates = [
    req.headers['x-codex-turn-metadata'],
    body?.responsesapi_client_metadata,
    body?.responsesapiClientMetadata,
    body?.metadata
  ]
  for (const candidate of candidates) {
    let value = candidate
    if (Array.isArray(value)) value = value[0]
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { continue }
    }
    if (!value || typeof value !== 'object') continue
    const sessionId = value.vscode_session_id
    const turnId = value.vscode_turn_id
    if (typeof sessionId === 'string' && typeof turnId === 'string' && sessionId && turnId) {
      return { sessionId, turnId }
    }
  }
  return undefined
}

export function markCodeTurnRequest(metadata, patch) {
  if (!metadata) return
  clean()
  const entryKey = key(metadata.sessionId, metadata.turnId)
  const previous = entries.get(entryKey)
  entries.set(entryKey, {
    sessionId: metadata.sessionId,
    turnId: metadata.turnId,
    state: patch.state,
    receivedAt: previous?.receivedAt ?? Date.now(),
    updatedAt: Date.now(),
    requestId: patch.requestId ?? previous?.requestId,
    model: patch.model ?? previous?.model,
    provider: patch.provider ?? previous?.provider,
    status: patch.status ?? previous?.status
  })
}

export function getCodeTurnRequestState(sessionId, turnId) {
  clean()
  return entries.get(key(sessionId, turnId)) || null
}
