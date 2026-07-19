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

  function extractOfficialLoginCandidates(files, { maxCandidates = 100 } = {}) {
    const candidates = new Map()
    const visited = new Set()
    const clean = (value, maxLength = 500) => {
      if (typeof value !== 'string') return ''
      const result = value.trim()
      return result && result.length <= maxLength ? result : ''
    }
    const first = (sources, keys, maxLength) => {
      for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue
        for (const key of keys) {
          const value = clean(source[key], maxLength)
          if (value) return value
        }
      }
      return ''
    }
    const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    const mergeCandidate = candidate => {
      if (!candidate.email || !validEmail(candidate.email) || candidates.size >= maxCandidates) return
      const key = candidate.accountId || candidate.email.toLowerCase()
      const existing = candidates.get(key) ||
        [...candidates.values()].find(item => item.email.toLowerCase() === candidate.email.toLowerCase())
      if (existing) {
        if (!existing.password && candidate.password) existing.password = candidate.password
        if (!existing.accountId && candidate.accountId) existing.accountId = candidate.accountId
        if ((!existing.label || existing.label === existing.email) && candidate.label) existing.label = candidate.label
        for (const name of candidate.sourceNames || []) {
          if (!existing.sourceNames.includes(name)) existing.sourceNames.push(name)
        }
        return
      }
      candidates.set(key, {
        email: candidate.email,
        password: candidate.password || '',
        accountId: candidate.accountId || '',
        label: candidate.label || candidate.email,
        sourceNames: [...new Set(candidate.sourceNames || [])]
      })
    }
    const inspectRecord = (record, sourceName) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return
      const credentials = [
        record.credentials,
        record.credential,
        record.tokens,
        record.auth?.credentials,
        record.auth?.tokens,
        record.auth,
        record
      ]
      const extra = record.extra && typeof record.extra === 'object' ? record.extra : null
      const sources = [...credentials, extra].filter(Boolean)
      const email = first(sources, ['email', 'login_email', 'loginEmail'], 320)
      if (!validEmail(email)) return
      mergeCandidate({
        email,
        // CPA JSON may contain the OpenAI account password. TXT companion
        // records often contain mailbox credentials instead, so those are
        // deliberately not treated as OpenAI passwords below.
        password: first(credentials, ['password', 'account_password', 'accountPassword'], 500),
        accountId: first(credentials, [
          'account_id',
          'accountId',
          'chatgpt_account_id',
          'chatgptAccountId',
          'workspace_id',
          'workspaceId'
        ], 240),
        label: first([record, extra, ...credentials], ['label', 'name', 'email'], 80) || email,
        sourceNames: [sourceName]
      })
    }
    const walk = (value, sourceName, depth = 0) => {
      if (depth > 6 || value == null || candidates.size >= maxCandidates) return
      if (Array.isArray(value)) {
        for (const item of value) walk(item, sourceName, depth + 1)
        return
      }
      if (typeof value !== 'object' || visited.has(value)) return
      visited.add(value)
      inspectRecord(value, sourceName)
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') walk(child, sourceName, depth + 1)
      }
    }
    for (const file of Array.isArray(files) ? files : []) {
      const sourceName = clean(file?.name, 260) || '未命名文件'
      const content = clean(file?.content, 2 * 1024 * 1024)
      if (!content) continue
      try {
        walk(JSON.parse(content.replace(/^\uFEFF/, '')), sourceName)
        continue
      } catch {}
      // Companion TXT files are useful for discovering the email address,
      // but their second and later fields may be mailbox OAuth credentials.
      // Keep only the email and never expose those fields as an OpenAI password.
      for (const line of content.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        const email = line.split(/-{4,}|\t|\||,/)[0]?.trim() || ''
        if (validEmail(email)) {
          mergeCandidate({
            email,
            label: email,
            password: '',
            accountId: '',
            sourceNames: [sourceName]
          })
        }
      }
    }
    return [...candidates.values()]
  }

  function accountCredentialDisplay(account, now = Date.now()) {
    const mode = account?.credential_mode === 'temporary_access' ? 'temporary_access' : 'refreshable'
    const compatibility = account?.credential_compatibility || 'codex_subscription'
    const compatible = mode !== 'temporary_access' || compatibility === 'codex_subscription'
    if (mode === 'refreshable') {
      return {
        mode,
        category: 'refreshable',
        temporary: false,
        compatible: true,
        compatibility,
        expired: false,
        expiringSoon: false,
        remainingMs: null,
        expires_at: null,
        countdown: '自动续约'
      }
    }
    const expiresAt = Number(account?.expires_at)
    const remainingMs = Number.isFinite(expiresAt) ? expiresAt - now : null
    const expired = remainingMs == null || remainingMs <= 0
    const expiringSoon = !expired && remainingMs <= 24 * 60 * 60 * 1000
    let countdown = '到期时间未知'
    if (expired) {
      countdown = '已到期'
    } else {
      const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000))
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      countdown = days > 0
        ? `${days}天 ${hours}小时`
        : hours > 0
          ? `${hours}小时 ${minutes}分钟`
          : `${minutes}分钟`
    }
    return {
      mode,
      category: !compatible ? 'incompatible' : (expired ? 'expired' : (expiringSoon ? 'expiring' : 'temporary')),
      temporary: true,
      compatible,
      compatibility,
      expired,
      expiringSoon,
      remainingMs,
      expires_at: Number.isFinite(expiresAt) ? expiresAt : null,
      countdown
    }
  }

  function inspectDirectImportFiles(files, now = Date.now()) {
    const codexClientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
    const clean = value => typeof value === 'string' ? value.trim() : ''
    const first = (sources, keys) => {
      for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue
        for (const key of keys) {
          const value = clean(source[key])
          if (value) return value
        }
      }
      return ''
    }
    const jwtMetadata = token => {
      try {
        const segment = String(token || '').split('.')[1]
        if (!segment) return null
        const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
        const json = typeof Buffer !== 'undefined'
          ? Buffer.from(normalized, 'base64').toString('utf8')
          : decodeURIComponent(Array.from(atob(normalized), char =>
              `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
        const payload = JSON.parse(json)
        return {
          expires_at: Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : null,
          compatible: payload.client_id === codexClientId
        }
      } catch {
        return { expires_at: null, compatible: false }
      }
    }
    const results = (Array.isArray(files) ? files : []).map(file => {
      const name = clean(file?.name) || '未命名文件'
      const content = clean(file?.content)
      const records = new Map()
      const visited = new Set()
      const inspect = record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return
        const sources = [
          record.tokens,
          record.credentials,
          record.credential,
          record.auth?.tokens,
          record.auth?.credentials,
          record.auth,
          record
        ].filter(Boolean)
        for (const source of sources) {
          const accessToken = first([source], ['access_token', 'accessToken'])
          const accountId = first([source], [
            'account_id',
            'accountId',
            'chatgpt_account_id',
            'chatgptAccountId',
            'workspace_id',
            'workspaceId'
          ])
          if (!accessToken || !accountId) continue
          const refreshToken = first([source], ['refresh_token', 'refreshToken'])
          const metadata = jwtMetadata(accessToken)
          records.set(accountId, {
            mode: refreshToken ? 'refreshable' : 'temporary_access',
            expires_at: metadata.expires_at,
            compatible: refreshToken ? true : metadata.compatible
          })
          break
        }
      }
      const walk = (value, depth = 0) => {
        if (depth > 6 || value == null) return
        if (Array.isArray(value)) {
          for (const item of value) walk(item, depth + 1)
          return
        }
        if (typeof value !== 'object' || visited.has(value)) return
        visited.add(value)
        inspect(value)
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') walk(child, depth + 1)
        }
      }
      try {
        walk(JSON.parse(content.replace(/^\uFEFF/, '')))
      } catch {
        const textRecord = {}
        for (const line of content.split(/\r?\n/)) {
          const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(line)
          if (match) textRecord[match[1]] = match[2]
        }
        inspect(textRecord)
      }
      const values = [...records.values()]
      const temporary = values.filter(item => item.mode === 'temporary_access')
      const refreshable = values.length - temporary.length
      const invalidTemporary = temporary.filter(item => !item.expires_at || item.expires_at <= now + 30_000)
      const incompatible = temporary.filter(item => !item.compatible)
      const earliest = temporary.map(item => item.expires_at).filter(Boolean).sort((a, b) => a - b)[0] || null
      return {
        name,
        accountIds: [...records.keys()],
        accounts: values.length,
        temporary: temporary.length,
        refreshable,
        invalidTemporary: invalidTemporary.length,
        incompatible: incompatible.length,
        earliest_expires_at: earliest,
        countdown: earliest
          ? accountCredentialDisplay({ credential_mode: 'temporary_access', expires_at: earliest }, now).countdown
          : null,
        importable: values.length > 0 && invalidTemporary.length === 0,
        directly_usable: values.length > 0 && invalidTemporary.length === 0 && incompatible.length === 0
      }
    })
    const seen = new Set()
    for (const result of results) {
      result.duplicate_accounts = result.accountIds.filter(accountId => seen.has(accountId)).length
      result.accountIds.forEach(accountId => seen.add(accountId))
      delete result.accountIds
    }
    return results
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
    extractOfficialLoginCandidates,
    accountCredentialDisplay,
    inspectDirectImportFiles,
    quotaResetFinalMessage
  }
})
