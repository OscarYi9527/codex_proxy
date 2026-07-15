(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.AdminUIBehaviors = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function quotaResetState({
    expectedAccount = '',
    enteredAccount = '',
    targetConfirmed = false,
    creditConfirmed = false,
    submitting = false
  } = {}) {
    const accountMatches = Boolean(expectedAccount) &&
      String(enteredAccount).trim() === String(expectedAccount)
    const ready = accountMatches && targetConfirmed === true &&
      creditConfirmed === true && submitting !== true
    return {
      accountMatches,
      targetConfirmed: targetConfirmed === true,
      creditConfirmed: creditConfirmed === true,
      submitting: submitting === true,
      ready,
      disabled: !ready,
      label: submitting ? '正在提交…' : '确认并继续'
    }
  }

  function applyQuotaResetButtonState(button, state) {
    if (!button) return state
    button.disabled = Boolean(state?.disabled)
    button.textContent = state?.label || '确认并继续'
    button.setAttribute?.('aria-disabled', String(Boolean(state?.disabled)))
    button.dataset && (button.dataset.submitting = String(Boolean(state?.submitting)))
    return state
  }

  function filterErrorGuides(guides, query = '') {
    const term = String(query || '').trim().toLowerCase()
    if (!term) return Array.isArray(guides) ? [...guides] : []
    return (Array.isArray(guides) ? guides : []).filter(item => [
      item?.status,
      item?.title,
      item?.meaning,
      ...(item?.causes || []),
      ...(item?.actions || [])
    ].join(' ').toLowerCase().includes(term))
  }

  function loginPollDecision(status) {
    const normalized = String(status || '').toLowerCase()
    if (normalized === 'waiting' || normalized === 'starting') {
      return { terminal: false, outcome: 'waiting', keepPolling: true }
    }
    if (normalized === 'success') {
      return { terminal: true, outcome: 'success', keepPolling: false }
    }
    if (normalized === 'error' || normalized === 'cancelled') {
      return { terminal: true, outcome: normalized, keepPolling: false }
    }
    return { terminal: false, outcome: 'unknown', keepPolling: true }
  }

  function quotaResetFinalMessage(accountName) {
    return `最后确认：确定立即重置「${String(accountName || '')}」的 Codex 额度吗？\n\n` +
      '此操作会消耗 1 次重置机会，提交后无法撤销。'
  }

  return {
    quotaResetState,
    applyQuotaResetButtonState,
    filterErrorGuides,
    loginPollDecision,
    quotaResetFinalMessage
  }
})
