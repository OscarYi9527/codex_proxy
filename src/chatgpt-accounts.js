// ChatGPT subscription account pool
// Holds credentials for one or more official ChatGPT accounts pasted in from
// `~/.codex/auth.json`, and rotates between them when the upstream reports
// the active account is rate-limited / over quota.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { proxyConfig, upsertChatgptAccount as persistAccount, deleteChatgptAccount as removeAccount } from './config.js'
import { id } from './server-utils.js'
import { chinaFetch, withChinaDispatcher } from './china-fetch.js'
import { getStats } from './stats.js'

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const USAGE_PATH = '/backend-api/wham/usage'
const RESET_CREDITS_PATH = '/backend-api/wham/rate-limit-reset-credits'
const RESET_CREDITS_CONSUME_PATH = '/backend-api/wham/rate-limit-reset-credits/consume'
const REFRESH_SAFETY_MARGIN_MS = 30 * 1000
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
const MAX_REASONABLE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const GLOBAL_USAGE_REFRESH_MS = 30 * 60 * 1000
const ACTIVE_USAGE_REFRESH_MS = 5 * 60 * 1000
const USAGE_FRESH_MS = 30 * 60 * 1000
// Multiple VS Code windows can legitimately overlap a foreground turn and
// helper requests. Keep a modest cap and queue anything above it.
const MAX_ACCOUNT_CONCURRENT_REQUESTS = 3
const LOW_QUOTA_THRESHOLD_PERCENT = 10
const SESSION_STICKY_TTL_MS = 30 * 60 * 1000
const MAX_STICKY_SESSIONS = 1000
const REQUEST_LEASE_TTL_MS = 6 * 60 * 1000
const ADAPTIVE_MIN_CONCURRENCY = 1
const ADAPTIVE_MAX_CONCURRENCY = MAX_ACCOUNT_CONCURRENT_REQUESTS
const ADAPTIVE_SUCCESS_STEP = 8
const stickyAccounts = new Map()
const accountRequestLeases = new Map()
const adaptiveConcurrency = new Map()
const usageRefreshFailures = new Map()
const tokenRefreshInFlight = new Map()
const usageRefreshInFlight = new Map()
const resetCreditConsumeInFlight = new Set()
let roundRobinCursor = 0

export const ACCOUNT_ROUTING_STRATEGIES = [
  'priority',
  'round-robin',
  'headroom',
  'least-used',
  'latency',
  'reliable',
  'weighted',
  'random',
  'lkgp'
]

export function normalizeAccountRoutingStrategy(strategy) {
  const normalized = String(strategy || '').trim().toLowerCase()
  return ACCOUNT_ROUTING_STRATEGIES.includes(normalized) ? normalized : 'headroom'
}

function decodeJwtExpiry(token) {
  try {
    const payloadSegment = token.split('.')[1]
    const payload = JSON.parse(Buffer.from(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return payload.exp ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export function parseAuthJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('auth.json 内容不是合法的 JSON')
  }
  const tokens = parsed?.tokens
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('auth.json 缺少 tokens 字段')
  }
  const { access_token, refresh_token, id_token, account_id } = tokens
  if (!access_token || !refresh_token || !account_id) {
    throw new Error('auth.json 缺少 access_token / refresh_token / account_id')
  }
  return { access_token, refresh_token, id_token, account_id }
}

export function addChatgptAccount(raw, label, { routingEnabled = undefined } = {}) {
  const { access_token, refresh_token, id_token, account_id } = parseAuthJson(raw)
  const existing = (proxyConfig.chatgptAccounts || []).find(account => account.account_id === account_id)
  const account = {
    id: existing?.id || id('acct'),
    label: label || existing?.label || account_id,
    access_token,
    refresh_token,
    id_token,
    account_id,
    expires_at: decodeJwtExpiry(access_token) || (Date.now() + 3600 * 1000),
    status: 'active',
    usage_sync_status: existing?.usage_updated_at ? 'synced' : 'pending',
    usage_sync_error: null,
    routing_enabled: routingEnabled ?? existing?.routing_enabled ?? true,
    cooldown_until: null,
    last_refresh: new Date().toISOString(),
    added_at: existing?.added_at || new Date().toISOString()
  }
  return persistAccount(account)
}

export function deleteChatgptAccount(accountId) {
  return removeAccount(accountId)
}

export function accountRemainingPercent(account) {
  const windows = [account?.usage?.primary, account?.usage?.secondary]
    .filter(Boolean)
    .map(window => {
      if (window.remaining_percent != null) return Number(window.remaining_percent)
      if (window.used_percent != null) return 100 - Number(window.used_percent)
      return null
    })
    .filter(value => Number.isFinite(value))
  // Both quota windows constrain availability, so the effective headroom is
  // the least remaining percentage across all known windows.
  return windows.length ? Math.max(0, Math.min(100, Math.min(...windows))) : null
}

export function accountUsageIsFresh(account, now = Date.now()) {
  const updatedAt = Date.parse(account?.usage_updated_at || '')
  return Number.isFinite(updatedAt) && now - updatedAt <= USAGE_FRESH_MS
}

function adaptiveState(accountId) {
  if (!adaptiveConcurrency.has(accountId)) {
    adaptiveConcurrency.set(accountId, {
      limit: ADAPTIVE_MAX_CONCURRENCY,
      successStreak: 0,
      lastReducedAt: null,
      lastReason: null
    })
  }
  return adaptiveConcurrency.get(accountId)
}

function reapExpiredLeases(accountId = null, now = Date.now()) {
  const entries = accountId
    ? [[accountId, accountRequestLeases.get(accountId)]]
    : [...accountRequestLeases.entries()]
  for (const [id, leases] of entries) {
    if (!leases) continue
    for (const [leaseId, lease] of leases) {
      if (Number(lease.expiresAt) <= now) leases.delete(leaseId)
    }
    if (!leases.size) accountRequestLeases.delete(id)
  }
}

export function accountActiveRequestCount(accountId) {
  reapExpiredLeases(accountId)
  return accountRequestLeases.get(accountId)?.size || 0
}

export function accountConcurrencyLimit(accountId) {
  return adaptiveState(accountId).limit
}

export function reserveAccountRequest(accountId, leaseId = id('lease')) {
  if (!accountId || accountActiveRequestCount(accountId) >= accountConcurrencyLimit(accountId)) return false
  const leases = accountRequestLeases.get(accountId) || new Map()
  if (leases.has(leaseId)) return true
  leases.set(leaseId, {
    leaseId,
    startedAt: Date.now(),
    expiresAt: Date.now() + REQUEST_LEASE_TTL_MS
  })
  accountRequestLeases.set(accountId, leases)
  return true
}

export function renewAccountRequestLease(accountId, leaseId) {
  const lease = accountRequestLeases.get(accountId)?.get(leaseId)
  if (!lease) return false
  lease.expiresAt = Date.now() + REQUEST_LEASE_TTL_MS
  return true
}

export function releaseAccountRequest(accountId, leaseId = null) {
  const leases = accountRequestLeases.get(accountId)
  if (!leases) return
  if (leaseId) leases.delete(leaseId)
  else {
    const oldest = [...leases.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest) leases.delete(oldest.leaseId)
  }
  if (!leases.size) accountRequestLeases.delete(accountId)
}

export function resetAccountRequestCounts() {
  accountRequestLeases.clear()
  adaptiveConcurrency.clear()
}

export function noteAccountAdaptiveOutcome(accountId, {
  status = 0,
  errorType = null,
  latencyMs = 0
} = {}) {
  if (!accountId) return
  const state = adaptiveState(accountId)
  const shouldReduce = status === 429 || errorType === 'network' || errorType === 'timeout' || latencyMs > 120_000
  if (shouldReduce) {
    state.limit = Math.max(ADAPTIVE_MIN_CONCURRENCY, state.limit - 1)
    state.successStreak = 0
    state.lastReducedAt = new Date().toISOString()
    state.lastReason = status === 429 ? 'rate_limit' : (errorType || 'high_latency')
    return
  }
  if (status >= 200 && status < 400) {
    state.successStreak++
    if (state.successStreak >= ADAPTIVE_SUCCESS_STEP && state.limit < ADAPTIVE_MAX_CONCURRENCY) {
      state.limit++
      state.successStreak = 0
      state.lastReason = 'recovered'
    }
  }
}

export function accountSessionKey(req) {
  const headers = req?.headers || {}
  return headers['session-id'] || headers['thread-id'] || headers['x-codex-window-id'] || null
}

function cleanupStickyAccounts(now = Date.now()) {
  for (const [key, value] of stickyAccounts) {
    if (now - value.updatedAt > SESSION_STICKY_TTL_MS) stickyAccounts.delete(key)
  }
  while (stickyAccounts.size > MAX_STICKY_SESSIONS) {
    stickyAccounts.delete(stickyAccounts.keys().next().value)
  }
}

export function noteAccountSuccess(sessionKey, accountId) {
  if (!sessionKey || !accountId) return
  cleanupStickyAccounts()
  stickyAccounts.set(sessionKey, { accountId, updatedAt: Date.now() })
}

export function resetAccountStickiness() {
  stickyAccounts.clear()
  roundRobinCursor = 0
}

function selectByStrategy(candidates, strategy, sessionKey) {
  const accountStats = getStats().accounts || {}
  const withMetrics = candidates.map(item => ({
    ...item,
    stats: accountStats[item.account.id] || {}
  }))
  const byHeadroom = (a, b) => {
    const aScore = a.remaining === null ? 50 : a.remaining
    const bScore = b.remaining === null ? 50 : b.remaining
    return bScore - aScore || a.index - b.index
  }

  if (strategy === 'lkgp') {
    const stickyId = sessionKey ? stickyAccounts.get(sessionKey)?.accountId : null
    const sticky = stickyId ? withMetrics.find(item => item.account.id === stickyId) : null
    if (sticky) return sticky.account
    strategy = 'reliable'
  }

  if (strategy === 'priority') return withMetrics[0].account
  if (strategy === 'round-robin') {
    const selected = withMetrics[roundRobinCursor % withMetrics.length].account
    roundRobinCursor = (roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER
    return selected
  }
  if (strategy === 'random') {
    return withMetrics[Math.floor(Math.random() * withMetrics.length)].account
  }
  if (strategy === 'weighted') {
    const weights = withMetrics.map(item => Math.max(0, Number(item.account.routing_weight) || 1))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let target = Math.random() * total
    for (let index = 0; index < withMetrics.length; index++) {
      target -= weights[index]
      if (target <= 0) return withMetrics[index].account
    }
    return withMetrics.at(-1).account
  }
  if (strategy === 'least-used') {
    withMetrics.sort((a, b) =>
      (Number(a.stats.requests) || 0) - (Number(b.stats.requests) || 0) || byHeadroom(a, b))
    return withMetrics[0].account
  }
  if (strategy === 'latency') {
    withMetrics.sort((a, b) => {
      const aLatency = Number(a.stats.p95_latency_ms || a.stats.average_latency_ms) || Number.MAX_SAFE_INTEGER
      const bLatency = Number(b.stats.p95_latency_ms || b.stats.average_latency_ms) || Number.MAX_SAFE_INTEGER
      return aLatency - bLatency || byHeadroom(a, b)
    })
    return withMetrics[0].account
  }
  if (strategy === 'reliable') {
    const reliabilityScore = item => {
      const success = item.stats.requests ? Number(item.stats.success_rate) : 50
      const headroom = item.remaining === null ? 50 : item.remaining
      const latency = Number(item.stats.p95_latency_ms || item.stats.average_latency_ms) || 1000
      return success * 0.6 + headroom * 0.3 + Math.max(0, 100 - latency / 100) * 0.1
    }
    withMetrics.sort((a, b) => reliabilityScore(b) - reliabilityScore(a) || byHeadroom(a, b))
    return withMetrics[0].account
  }

  withMetrics.sort(byHeadroom)
  return withMetrics[0].account
}

// Selects the healthiest account by quota headroom while preserving the last
// successful account for a session. Accounts below the low-quota threshold
// are avoided whenever another eligible account exists.
export function pickActiveAccount(excludeIds = null, {
  sessionKey = null,
  model = null,
  lowQuotaThreshold = proxyConfig.chatgptLowQuotaThreshold ?? LOW_QUOTA_THRESHOLD_PERCENT,
  strategy = proxyConfig.chatgptAccountStrategy
} = {}) {
  const accounts = proxyConfig.chatgptAccounts || []
  const now = Date.now()
  cleanupStickyAccounts(now)
  const eligible = []
  for (const account of accounts) {
    if (excludeIds && excludeIds.has(account.id)) continue
    if (
      account.cooldown_until &&
      (now > account.cooldown_until || account.cooldown_until > now + MAX_REASONABLE_COOLDOWN_MS)
    ) {
      account.status = 'active'
      account.cooldown_until = null
      if (account.last_cooldown_reason === 'rate_limit') {
        account.last_cooldown_reason = null
      }
      persistAccount(account)
    }
    if (account.model_cooldowns && typeof account.model_cooldowns === 'object') {
      let changed = false
      for (const [cooldownModel, until] of Object.entries(account.model_cooldowns)) {
        if (!Number(until) || now > Number(until)) {
          delete account.model_cooldowns[cooldownModel]
          changed = true
        }
      }
      if (changed) persistAccount(account)
    }
    if (
      (account.status === 'active' || !account.status) &&
      account.routing_enabled !== false &&
      (!model || !account.model_cooldowns?.[model]) &&
      accountActiveRequestCount(account.id) < accountConcurrencyLimit(account.id)
    ) eligible.push(account)
  }
  if (!eligible.length) return null

  const scored = eligible.map((account, index) => ({
    account,
    index,
    remaining: accountRemainingPercent(account),
    usageFresh: accountUsageIsFresh(account, now)
  }))
  const freshHealthy = scored.filter(item =>
    item.usageFresh && item.remaining !== null && item.remaining > lowQuotaThreshold)
  const healthy = scored.filter(item => item.remaining === null || item.remaining > lowQuotaThreshold)
  // The configured threshold is a reserve, not merely a preference. Unknown
  // quota remains eligible, but a known account at/below the reserve does not.
  const candidates = freshHealthy.length ? freshHealthy : healthy
  if (!candidates.length) return null
  return selectByStrategy(candidates, normalizeAccountRoutingStrategy(strategy), sessionKey)
}

export async function ensureFreshToken(account, fetchImpl = fetch) {
  const managedByLocalCodex = proxyConfig.activeChatgptAccountId === account.id
  if (managedByLocalCodex) syncActiveAccountFromCodexHome(account)
  if (account.expires_at && account.expires_at - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
    return account
  }
  if (managedByLocalCodex) {
    const error = new Error('当前本机账号的 Token 尚未由 Codex 刷新，将暂时尝试其他账号')
    error.code = 'TOKEN_REFRESH_ACTIVE_SOURCE_STALE'
    error.retryable = true
    throw error
  }
  if (tokenRefreshInFlight.has(account.id)) return tokenRefreshInFlight.get(account.id)
  const refreshPromise = (async () => {
    let response
    try {
      response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: account.refresh_token
        })
      })
    } catch (cause) {
      const error = new Error(`ChatGPT 账号 token 刷新遇到网络错误：${cause.message}`)
      error.code = 'TOKEN_REFRESH_TRANSIENT'
      error.retryable = true
      error.cause = cause
      throw error
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const permanent = response.status === 400 || response.status === 401 || /invalid_grant|refresh token.*(?:invalid|expired|revoked)/i.test(text)
      const error = new Error(
        permanent
          ? 'ChatGPT 登录凭据已失效，需要重新进行官方登录'
          : `ChatGPT 账号 token 暂时无法刷新 (status ${response.status})`
      )
      error.code = permanent ? 'TOKEN_REFRESH_RELOGIN_REQUIRED' : 'TOKEN_REFRESH_TRANSIENT'
      error.retryable = !permanent
      error.status = response.status
      if (permanent) {
        account.status = 'auth_error'
        account.auth_error = {
          type: 'relogin_required',
          status: response.status,
          at: new Date().toISOString()
        }
        persistAccount(account)
      }
      throw error
    }
    const data = await response.json()
    account.access_token = data.access_token || account.access_token
    account.refresh_token = data.refresh_token || account.refresh_token
    account.id_token = data.id_token || account.id_token
    account.expires_at = decodeJwtExpiry(account.access_token) || (Date.now() + 3600 * 1000)
    account.last_refresh = new Date().toISOString()
    account.status = 'active'
    account.auth_error = null
    persistAccount(account)
    return account
  })()
  tokenRefreshInFlight.set(account.id, refreshPromise)
  try {
    return await refreshPromise
  } finally {
    if (tokenRefreshInFlight.get(account.id) === refreshPromise) tokenRefreshInFlight.delete(account.id)
  }
}

export function cooldownMsFromResponseText(text, now = Date.now()) {
  const match = String(text || '').match(/"resets?_(in|at)"\s*:\s*"?(\d+)/i)
  if (!match) return null
  const kind = match[1].toLowerCase()
  const value = Number(match[2])
  if (!Number.isFinite(value) || value <= 0) return null
  if (kind === 'at') {
    const resetAtMs = value > 1e12 ? value : value * 1000
    return resetAtMs - now
  }
  return value * 1000
}

// `response` should be an unconsumed clone (or a response whose body you no
// longer need) since this may read its body to look for a reset time.
export async function markAccountCooldown(accountId, response, { model = null, scope = 'model' } = {}) {
  const accounts = proxyConfig.chatgptAccounts || []
  const account = accounts.find(a => a.id === accountId)
  if (!account) return

  let cooldownMs = DEFAULT_COOLDOWN_MS
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    cooldownMs = Number(retryAfter) * 1000
  } else if (response) {
    try {
      const text = await response.text()
      cooldownMs = cooldownMsFromResponseText(text) ?? cooldownMs
    } catch {}
  }

  cooldownMs = Math.max(1000, Math.min(cooldownMs, MAX_REASONABLE_COOLDOWN_MS))
  const cooldownUntil = Date.now() + cooldownMs
  if (model && scope === 'model') {
    account.model_cooldowns ||= {}
    account.model_cooldowns[model] = cooldownUntil
    account.last_cooldown_model = model
    account.last_cooldown_reason = 'rate_limit'
  } else {
    account.status = 'cooldown'
    account.cooldown_until = cooldownUntil
    account.last_cooldown_reason = 'rate_limit'
  }
  persistAccount(account)
}

export function markAccountAuthFailure(accountId, status, message = null) {
  const account = (proxyConfig.chatgptAccounts || []).find(item => item.id === accountId)
  if (!account) return
  account.status = 'auth_error'
  account.auth_error = {
    type: 'upstream_authentication',
    status: Number(status) || null,
    message: message ? String(message).slice(0, 200) : null,
    at: new Date().toISOString()
  }
  persistAccount(account)
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null)
}

function normalizeEpochSeconds(value) {
  const n = numOrNull(value)
  if (n === null) return null
  return n > 1e12 ? Math.round(n / 1000) : n
}

function normalizeWindow(w) {
  if (!w) return null
  const usedPercent = numOrNull(firstDefined(
    w.used_percent,
    w.usedPercent,
    w.utilization,
    w.utilization_percent
  ))
  if (usedPercent === null) return null
  const normalizedUsed = Math.max(0, Math.min(100, usedPercent))
  const windowMinutes = numOrNull(firstDefined(
    w.window_minutes,
    w.windowMinutes,
    w.limit_window_minutes,
    numOrNull(w.limit_window_seconds) === null ? null : Number(w.limit_window_seconds) / 60,
    numOrNull(w.window_seconds) === null ? null : Number(w.window_seconds) / 60
  ))
  // The usage endpoint may emit a zero-length secondary window as a
  // placeholder when that window is not currently part of the policy.
  if (windowMinutes !== null && windowMinutes <= 0) return null
  return {
    used_percent: normalizedUsed,
    remaining_percent: Math.max(0, 100 - normalizedUsed),
    window_minutes: windowMinutes,
    resets_at: normalizeEpochSeconds(firstDefined(w.resets_at, w.resetsAt, w.reset_at, w.resetAt)),
    reset_after_seconds: numOrNull(firstDefined(
      w.reset_after_seconds,
      w.resetAfterSeconds,
      w.resets_in_seconds,
      w.reset_in_seconds
    ))
  }
}

function classifyUsageWindows(namedPrimary, namedSecondary) {
  const entries = [
    { name: 'primary', window: namedPrimary },
    { name: 'secondary', window: namedSecondary }
  ].filter(item => item.window)
  let primary = null
  let secondary = null
  const assigned = new Set()

  // `primary_window` means the provider's first active limit, not
  // necessarily the historical 5-hour window. Classify known durations
  // before falling back to the provider's field names.
  for (const item of entries) {
    const minutes = Number(item.window.window_minutes)
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60 && !primary) {
      primary = item.window
      assigned.add(item)
    } else if (Number.isFinite(minutes) && minutes >= 6 * 24 * 60 && !secondary) {
      secondary = item.window
      assigned.add(item)
    }
  }
  for (const item of entries) {
    if (assigned.has(item)) continue
    if (item.name === 'primary' && !primary) primary = item.window
    else if (item.name === 'secondary' && !secondary) secondary = item.window
    else if (!primary) primary = item.window
    else if (!secondary) secondary = item.window
  }
  return { primary, secondary }
}

// The ChatGPT usage endpoint's response shape is undocumented and has been
// observed to vary (`rate_limits.primary` vs top-level `primary`), so this
// parses defensively and returns null rather than throwing on an unrecognized shape.
export function extractUsageFromBody(data) {
  const rl = data?.rate_limits || data?.rate_limit || data
  if (!rl) return null
  const windows = classifyUsageWindows(
    normalizeWindow(rl.primary || rl.primary_window || data?.primary || data?.primary_window),
    normalizeWindow(rl.secondary || rl.secondary_window || data?.secondary || data?.secondary_window)
  )
  const { primary, secondary } = windows
  if (!primary && !secondary) return null
  return {
    plan_type: data?.plan_type || rl.plan_type || null,
    primary,
    secondary,
    complete_windows: true
  }
}

// Same data, as opportunistically exposed via response headers on ordinary
// chatgpt-sub traffic (`x-codex-primary-used-percent` etc) - lets the account
// pool pick up fresh quota numbers for free from real proxied requests.
export function extractUsageFromHeaders(headers) {
  const get = name => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name])
  const primaryPct = numOrNull(get('x-codex-primary-used-percent'))
  const secondaryPct = numOrNull(get('x-codex-secondary-used-percent'))
  if (primaryPct === null && secondaryPct === null) return null
  const windows = classifyUsageWindows(
    normalizeWindow(primaryPct === null ? null : {
      used_percent: primaryPct,
      window_minutes: numOrNull(get('x-codex-primary-window-minutes')),
      resets_at: null,
      reset_after_seconds: numOrNull(get('x-codex-primary-reset-after-seconds'))
    }),
    normalizeWindow(secondaryPct === null ? null : {
      used_percent: secondaryPct,
      window_minutes: numOrNull(get('x-codex-secondary-window-minutes')),
      resets_at: null,
      reset_after_seconds: numOrNull(get('x-codex-secondary-reset-after-seconds'))
    })
  )
  return {
    plan_type: get('x-codex-plan-type') || null,
    ...windows,
    complete_windows: false
  }
}

function normalizeResetCreditExpiry(value) {
  if (value == null || value === '') return null
  let timestamp
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value)
    timestamp = numeric < 1e12 ? numeric * 1000 : numeric
  } else {
    timestamp = Date.parse(String(value))
  }
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

// The reset-credit endpoint is not part of the public OpenAI API and its
// response has changed before. Keep the parser defensive, while preserving
// redeem_request_id only in the short-lived return value used by consume.
export function extractResetCredits(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const root = data.rate_limit_reset_credits || data.reset_credits || data
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const rawCredits = Array.isArray(root.credits)
    ? root.credits
    : (Array.isArray(root.items) ? root.items : [])
  const credits = rawCredits.map(item => {
    if (!item || typeof item !== 'object') return null
    return {
      redeem_request_id: item.redeem_request_id || item.redeemRequestId || item.id || null,
      expires_at: normalizeResetCreditExpiry(item.expires_at ?? item.expiresAt),
      status: item.status == null ? null : String(item.status).toLowerCase()
    }
  }).filter(Boolean)
  const now = Date.now()
  const usableCredits = credits.filter(item =>
    !['consumed', 'redeemed', 'expired', 'used'].includes(item.status) &&
    (!item.expires_at || Date.parse(item.expires_at) > now)
  )
  const availableCount = Number(
    root.available_count ?? root.availableCount ?? root.remaining_count ?? root.remainingCount
  )
  const totalEarnedCount = Number(
    root.total_earned_count ?? root.totalEarnedCount ?? root.total_count ?? root.totalCount
  )
  return {
    available_count: Number.isFinite(availableCount)
      ? Math.max(0, Math.trunc(availableCount))
      : usableCredits.length,
    total_earned_count: Number.isFinite(totalEarnedCount) ? Math.max(0, Math.trunc(totalEarnedCount)) : credits.length,
    credits
  }
}

function publicResetCredits(resetCredits, updatedAt = new Date().toISOString()) {
  return {
    available_count: resetCredits.available_count,
    total_earned_count: resetCredits.total_earned_count,
    expires_at: [...new Set(resetCredits.credits.map(item => item.expires_at).filter(Boolean))].sort(),
    updated_at: updatedAt
  }
}

async function prepareAccountForBackendRequest(account, fetchImpl) {
  if (proxyConfig.activeChatgptAccountId === account.id) {
    syncActiveAccountFromCodexHome(account)
  } else {
    await ensureFreshToken(account, fetchImpl)
  }
  return (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
}

async function fetchAccountResetCredits(account, fetchImpl = fetch) {
  const currentAccount = await prepareAccountForBackendRequest(account, fetchImpl)
  const backendOrigin = new URL(proxyConfig.chatgptResponsesUrl).origin
  const response = await fetchImpl(backendOrigin + RESET_CREDITS_PATH, withChinaDispatcher({
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${currentAccount.access_token}`,
      'chatgpt-account-id': currentAccount.account_id,
      accept: 'application/json'
    }
  }))
  if (!response.ok) {
    throw new Error(`获取 Codex 重置次数失败 (status ${response.status})`)
  }
  let data = null
  try { data = await response.json() } catch {}
  const parsed = extractResetCredits(data)
  if (!parsed) throw new Error('Codex 重置次数接口返回了未知格式')
  return { account: currentAccount, parsed }
}

export async function refreshAccountResetCredits(account, fetchImpl = fetch) {
  const currentAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
  try {
    const result = await fetchAccountResetCredits(currentAccount, fetchImpl)
    const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || result.account
    latestAccount.reset_credits = publicResetCredits(result.parsed)
    latestAccount.reset_credits_error = null
    persistAccount(latestAccount)
    return latestAccount.reset_credits
  } catch (error) {
    const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || currentAccount
    latestAccount.reset_credits_error = String(error?.message || error).slice(0, 300)
    persistAccount(latestAccount)
    throw error
  }
}

function resetCreditError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function consumeAccountResetCredit(account, {
  confirmed = false,
  confirmedTargetAccount = false,
  confirmedCreditConsumption = false,
  confirmedAccountId = '',
  confirmedAccountLabel = ''
} = {}, fetchImpl = fetch) {
  if (confirmed !== true) throw resetCreditError('必须明确确认额度重置操作', 'CONFIRMATION_REQUIRED')
  if (confirmedTargetAccount !== true) {
    throw resetCreditError('必须勾选确认当前额度重置的目标账号', 'TARGET_ACCOUNT_CONFIRMATION_REQUIRED')
  }
  if (confirmedCreditConsumption !== true) {
    throw resetCreditError('必须确认额度重置会消耗 1 次机会且无法撤销', 'RESET_IMPACT_CONFIRMATION_REQUIRED')
  }
  const expectedLabel = String(account?.label || account?.account_id || account?.id || '')
  if (!expectedLabel || confirmedAccountLabel !== expectedLabel) {
    throw resetCreditError('二次确认的账号名称不匹配', 'ACCOUNT_LABEL_CONFIRMATION_MISMATCH')
  }
  if (!account?.account_id || confirmedAccountId !== account.account_id) {
    throw resetCreditError('二次确认的账号 ID 不匹配', 'ACCOUNT_CONFIRMATION_MISMATCH')
  }
  if (resetCreditConsumeInFlight.has(account.id)) {
    throw resetCreditError('该账号正在重置额度，请勿重复提交', 'RESET_IN_PROGRESS')
  }

  resetCreditConsumeInFlight.add(account.id)
  try {
    // Always query again immediately before consume. Never trust the cached
    // count or persist the one-time redeem_request_id.
    const { account: currentAccount, parsed } = await fetchAccountResetCredits(account, fetchImpl)
    if (parsed.available_count <= 0) {
      throw resetCreditError('该账号当前没有可用的 Codex 额度重置次数', 'NO_RESET_CREDITS')
    }
    const now = Date.now()
    const candidate = parsed.credits
      .filter(item => {
        if (!item.redeem_request_id) return false
        if (['consumed', 'redeemed', 'expired', 'used'].includes(item.status)) return false
        return !item.expires_at || Date.parse(item.expires_at) > now
      })
      .sort((a, b) => Date.parse(a.expires_at || '9999-12-31') - Date.parse(b.expires_at || '9999-12-31'))[0]
    if (!candidate) {
      throw resetCreditError('重置次数数据缺少有效的兑换标识，请先稍后重试查询', 'RESET_CREDIT_INVALID')
    }

    const backendOrigin = new URL(proxyConfig.chatgptResponsesUrl).origin
    const response = await fetchImpl(backendOrigin + RESET_CREDITS_CONSUME_PATH, withChinaDispatcher({
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${currentAccount.access_token}`,
        'chatgpt-account-id': currentAccount.account_id,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ redeem_request_id: candidate.redeem_request_id })
    }))
    if (!response.ok) {
      throw new Error(`Codex 额度重置失败 (status ${response.status})`)
    }

    const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || currentAccount
    latestAccount.last_quota_reset_at = new Date().toISOString()
    latestAccount.reset_credits = publicResetCredits({
      ...parsed,
      available_count: Math.max(0, parsed.available_count - 1),
      credits: parsed.credits.filter(item => item !== candidate)
    }, latestAccount.last_quota_reset_at)
    persistAccount(latestAccount)

    const refreshWarnings = []
    try {
      const refreshedAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || latestAccount
      await refreshAccountUsage(refreshedAccount, fetchImpl)
    } catch (error) {
      refreshWarnings.push(error?.message || String(error))
    }
    try {
      const refreshedAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || latestAccount
      await refreshAccountResetCredits(refreshedAccount, fetchImpl)
    } catch (error) {
      refreshWarnings.push(error?.message || String(error))
    }
    return {
      reset_at: latestAccount.last_quota_reset_at,
      refresh_warnings: refreshWarnings
    }
  } finally {
    resetCreditConsumeInFlight.delete(account.id)
  }
}

export function mergeAccountUsageWindows(previous = {}, usage = {}) {
  const complete = usage.complete_windows === true
  return {
    primary: usage.primary ?? (complete ? null : previous.primary ?? null),
    secondary: usage.secondary ?? (complete ? null : previous.secondary ?? null)
  }
}

export function applyAccountUsage(accountId, usage) {
  if (!usage) return
  const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
  if (!account) return
  account.plan_type = usage.plan_type || account.plan_type || null
  account.usage = mergeAccountUsageWindows(account.usage, usage)
  const now = Date.now()
  account.usage_updated_at = new Date(now).toISOString()
  account.usage_history ||= []
  const snapshot = {
    at: account.usage_updated_at,
    primary_remaining: account.usage.primary?.remaining_percent ?? null,
    secondary_remaining: account.usage.secondary?.remaining_percent ?? null
  }
  const previous = account.usage_history.at(-1)
  const changed = !previous ||
    Math.abs(Number(previous.primary_remaining) - Number(snapshot.primary_remaining)) >= 1 ||
    Math.abs(Number(previous.secondary_remaining) - Number(snapshot.secondary_remaining)) >= 1
  if (!previous || changed || now - Date.parse(previous.at) >= 5 * 60 * 1000) {
    account.usage_history.push(snapshot)
  }
  const cutoff = now - 7 * 24 * 60 * 60 * 1000
  account.usage_history = account.usage_history
    .filter(item => Date.parse(item.at) >= cutoff)
    .slice(-200)
  account.usage_forecast = calculateUsageForecast(account, proxyConfig.chatgptLowQuotaThreshold ?? 10, now)
  account.usage_sync_status = 'synced'
  account.usage_sync_error = null
  persistAccount(account)
}

export function calculateUsageForecast(account, reservePercent = 10, now = Date.now()) {
  const history = (account?.usage_history || [])
    .filter(item => Number.isFinite(Date.parse(item.at)))
    .slice(-48)
  const forecastWindow = key => {
    const samples = history
      .map(item => ({ at: Date.parse(item.at), remaining: Number(item[key]) }))
      .filter(item => Number.isFinite(item.remaining) && now - item.at <= 24 * 60 * 60 * 1000)
    if (samples.length < 2) return null
    const first = samples[0]
    const last = samples.at(-1)
    const hours = (last.at - first.at) / 3_600_000
    const consumed = first.remaining - last.remaining
    if (hours < 1 / 12 || consumed <= 0) return null
    const percentPerHour = consumed / hours
    const usable = Math.max(0, last.remaining - Number(reservePercent || 0))
    return {
      percent_per_hour: Number(percentPerHour.toFixed(2)),
      estimated_minutes_to_reserve: Math.round(usable / percentPerHour * 60),
      samples: samples.length,
      confidence: samples.length >= 8 ? 'high' : (samples.length >= 4 ? 'medium' : 'low')
    }
  }
  return {
    generated_at: new Date(now).toISOString(),
    primary: forecastWindow('primary_remaining'),
    secondary: forecastWindow('secondary_remaining')
  }
}

function getCodexAuthFile() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'auth.json')
}

// The account currently switched-to is mirrored into the real local
// ~/.codex/auth.json so the local Codex CLI/app/VSCode extension can use it
// directly, and that file's own refresh cycle (run by the local Codex
// tooling, entirely outside this proxy) is the source of truth for its
// tokens from that point on. Refresh tokens are rotating/single-use, so if
// this proxy also refreshed them independently on its background timer, the
// two would race and invalidate each other's copy - the exact "Your access
// token could not be refreshed..." failure this project hit before. So for
// the active account we only ever re-read the file here, never call the
// OAuth refresh endpoint ourselves.
function syncActiveAccountFromCodexHome(account) {
  try {
    const raw = fs.readFileSync(getCodexAuthFile(), 'utf8')
    const { access_token, refresh_token, id_token, account_id } = parseAuthJson(raw)
    if (account_id !== account.account_id || access_token === account.access_token) return
    account.access_token = access_token
    account.refresh_token = refresh_token
    account.id_token = id_token
    account.expires_at = decodeJwtExpiry(access_token) || account.expires_at
    persistAccount(account)
  } catch {}
}

async function refreshAccountUsageOnce(account, fetchImpl = fetch) {
  account = await prepareAccountForBackendRequest(account, fetchImpl)
  const base = new URL(proxyConfig.chatgptResponsesUrl).origin
  const response = await fetchImpl(base + USAGE_PATH, withChinaDispatcher({
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${account.access_token}`,
      'chatgpt-account-id': account.account_id,
      accept: 'application/json'
    }
  }))
  if (!response.ok) {
    throw new Error(`获取账号用量失败 (status ${response.status})`)
  }
  let data = null
  try { data = await response.json() } catch {}
  const usage = extractUsageFromBody(data) || extractUsageFromHeaders(response.headers)
  if (!usage) throw new Error('用量接口返回了未知格式')
  applyAccountUsage(account.id, usage)
  return account
}

export async function refreshAccountUsage(account, fetchImpl = fetch) {
  if (usageRefreshInFlight.has(account.id)) return usageRefreshInFlight.get(account.id)
  const currentAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
  currentAccount.usage_sync_status = 'refreshing'
  currentAccount.usage_sync_error = null
  persistAccount(currentAccount)
  const refreshPromise = refreshAccountUsageOnce(currentAccount, fetchImpl).catch(error => {
    const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || currentAccount
    latestAccount.usage_sync_status = 'error'
    latestAccount.usage_sync_error = String(error?.message || error).slice(0, 300)
    persistAccount(latestAccount)
    throw error
  })
  usageRefreshInFlight.set(account.id, refreshPromise)
  try {
    return await refreshPromise
  } finally {
    if (usageRefreshInFlight.get(account.id) === refreshPromise) usageRefreshInFlight.delete(account.id)
  }
}

async function refreshAllUsageQuiet() {
  for (const account of (proxyConfig.chatgptAccounts || []).filter(a => a.routing_enabled !== false)) {
    const failure = usageRefreshFailures.get(account.id)
    if (failure?.nextAttemptAt > Date.now()) continue
    try {
      await refreshAccountUsage(account, chinaFetch(fetch))
      usageRefreshFailures.delete(account.id)
    } catch (error) {
      const failures = Math.min(4, (failure?.failures || 0) + 1)
      usageRefreshFailures.set(account.id, {
        failures,
        nextAttemptAt: Date.now() + GLOBAL_USAGE_REFRESH_MS * Math.pow(2, failures - 1)
      })
      console.error('[codex-proxy] usage refresh failed for %s: %s', account.label || account.id, error.message)
    }
    await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)))
  }
}

async function refreshActiveUsageQuiet() {
  const activeId = proxyConfig.activeChatgptAccountId
  if (!activeId) return
  const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === activeId)
  if (!account || account.routing_enabled === false || accountUsageIsFresh(account)) return
  const failure = usageRefreshFailures.get(account.id)
  if (failure?.nextAttemptAt > Date.now()) return
  try {
    await refreshAccountUsage(account, chinaFetch(fetch))
    usageRefreshFailures.delete(account.id)
  } catch (error) {
    const failures = Math.min(4, (failure?.failures || 0) + 1)
    usageRefreshFailures.set(account.id, {
      failures,
      nextAttemptAt: Date.now() + ACTIVE_USAGE_REFRESH_MS * Math.pow(2, failures - 1)
    })
    console.error('[codex-proxy] active-account usage refresh failed: %s', error.message)
  }
}

function scheduleWithJitter(task, baseMs) {
  const delayMs = Math.round(baseMs * (0.85 + Math.random() * 0.3))
  const timer = setTimeout(async () => {
    try { await task() } finally { scheduleWithJitter(task, baseMs) }
  }, delayMs)
  timer.unref()
}

export function repairAccountRuntimeState(now = Date.now()) {
  let repaired = 0
  reapExpiredLeases(null, now)
  for (const account of (proxyConfig.chatgptAccounts || [])) {
    let changed = false
    if (
      account.cooldown_until &&
      (Number(account.cooldown_until) <= now || Number(account.cooldown_until) > now + MAX_REASONABLE_COOLDOWN_MS)
    ) {
      account.cooldown_until = null
      if (account.status === 'cooldown') account.status = 'active'
      changed = true
    }
    if (account.model_cooldowns && typeof account.model_cooldowns === 'object') {
      for (const [model, until] of Object.entries(account.model_cooldowns)) {
        if (!Number(until) || Number(until) <= now || Number(until) > now + MAX_REASONABLE_COOLDOWN_MS) {
          delete account.model_cooldowns[model]
          changed = true
        }
      }
    }
    if (changed) {
      persistAccount(account)
      repaired++
    }
  }
  return repaired
}

export function getAccountRuntimeDiagnostics() {
  reapExpiredLeases()
  return (proxyConfig.chatgptAccounts || []).map(account => {
    const adaptive = adaptiveState(account.id)
    return {
      id: account.id,
      status: account.status || 'active',
      routing_enabled: account.routing_enabled !== false,
      active_requests: accountActiveRequestCount(account.id),
      concurrency_limit: adaptive.limit,
      adaptive_reason: adaptive.lastReason,
      token_refresh_in_flight: tokenRefreshInFlight.has(account.id),
      usage_refresh_in_flight: usageRefreshInFlight.has(account.id),
      remaining_percent: accountRemainingPercent(account),
      cooldown_until: account.cooldown_until || null,
      model_cooldowns: Object.keys(account.model_cooldowns || {}).length,
      usage_forecast: account.usage_forecast || null
    }
  })
}

// Stable-mode refresh policy: prefer quota headers from real responses,
// refresh enabled accounts every ~30 minutes with jitter, and refresh the
// current account no more than every ~5 minutes. Failures back off exponentially.
if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  repairAccountRuntimeState()
  setInterval(() => reapExpiredLeases(), 60_000).unref()
  scheduleWithJitter(refreshAllUsageQuiet, GLOBAL_USAGE_REFRESH_MS)
  scheduleWithJitter(refreshActiveUsageQuiet, ACTIVE_USAGE_REFRESH_MS)
}
