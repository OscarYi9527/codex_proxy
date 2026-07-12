const MAX_DECISIONS = 200
const decisions = []

export function recordRouteDecision(decision = {}) {
  const entry = {
    at: new Date().toISOString(),
    request_id: String(decision.requestId || ''),
    model: String(decision.model || ''),
    provider: String(decision.provider || ''),
    selected_account_id: decision.selectedAccountId ? String(decision.selectedAccountId) : null,
    selected_account_label: decision.selectedAccountLabel ? String(decision.selectedAccountLabel).slice(0, 80) : null,
    outcome: String(decision.outcome || 'selected'),
    queue_wait_ms: Math.max(0, Number(decision.queueWaitMs) || 0),
    accounts: (decision.accounts || []).slice(0, 50).map(item => ({
      id: String(item.id || ''),
      label: String(item.label || '').slice(0, 80),
      result: String(item.result || ''),
      reason: String(item.reason || '').slice(0, 160),
      remaining_percent: Number.isFinite(Number(item.remainingPercent))
        ? Number(item.remainingPercent)
        : null
    }))
  }
  decisions.push(entry)
  if (decisions.length > MAX_DECISIONS) decisions.splice(0, decisions.length - MAX_DECISIONS)
  return entry
}

export function getRouteDecisions(limit = 50) {
  return decisions.slice(-Math.max(1, Math.min(MAX_DECISIONS, Number(limit) || 50))).reverse()
}

export function resetRouteDecisions() {
  decisions.length = 0
}
