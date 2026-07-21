// ChatGPT subscription account pool
// Holds credentials for one or more official ChatGPT accounts pasted in from
// `~/.codex/auth.json`, and rotates between them when the upstream reports
// the active account is rate-limited / over quota.

import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  proxyConfig,
  upsertChatgptAccount as persistAccountImmediately,
  deleteChatgptAccount as removeAccount
} from './config.js'
import { id } from './server-utils.js'
import { chinaFetch, withChinaDispatcher } from './china-fetch.js'
import { getStats, statsDayKey } from './stats.js'
import { appendAccountHealthEvents } from './account-store.js'
import { safeErrorText } from './logger.js'

export const CHATGPT_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
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
const RESET_CREDITS_REFRESH_MS = 6 * 60 * 60 * 1000
const RESET_CREDITS_FRESH_MS = 12 * 60 * 60 * 1000
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
const DISPOSABLE_RESET_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const TRANSIENT_HEALTH_QUARANTINE_FAILURES = 3
const TRANSIENT_HEALTH_QUARANTINE_BASE_MS = 5 * 60 * 1000
const stickyAccounts = new Map()
const accountRequestLeases = new Map()
const adaptiveConcurrency = new Map()
const usageRefreshFailures = new Map()
const tokenRefreshInFlight = new Map()
const usageRefreshInFlight = new Map()
const resetCreditsRefreshInFlight = new Map()
const accountStatusCheckInFlight = new Map()
const resetCreditConsumeInFlight = new Set()
const accountPersistenceScope = new AsyncLocalStorage()
const pendingHealthEvent = Symbol('pendingHealthEvent')

function persistAccount(account) {
  const store = accountPersistenceScope.getStore()
  if (store) {
    store.captureAccount(account)
    if (account[pendingHealthEvent]) {
      recordAccountHealthEvent(account, account[pendingHealthEvent])
      delete account[pendingHealthEvent]
    }
    return proxyConfig
  }
  const result = persistAccountImmediately(account)
  if (account[pendingHealthEvent]) {
    recordAccountHealthEvent(account, account[pendingHealthEvent])
    delete account[pendingHealthEvent]
  }
  return result
}

export function withAccountStore(store, callback) {
  if (!store || typeof store.captureAccount !== 'function' || typeof store.flush !== 'function') {
    throw new Error('Account store must support captureAccount() and flush()')
  }
  if (typeof callback !== 'function') throw new Error('Account store callback is required')
  return accountPersistenceScope.run(store, callback)
}

function recordAccountHealthEvent(account, health) {
  const event = {
    id: `${account.id}:${health.checked_at}:${health.state}`,
    account_id: account.id,
    ...health
  }
  const store = accountPersistenceScope.getStore()
  if (store && typeof store.appendHealthEvents === 'function') {
    store.appendHealthEvents([event])
  } else {
    appendAccountHealthEvents([event])
  }
}
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

export const ACCOUNT_POOL_TIERS = ['stable', 'disposable']

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

export function parseAuthJson(raw, { allowAccessOnly = false } = {}) {
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
  if (!access_token || !account_id || (!refresh_token && !allowAccessOnly)) {
    throw new Error('auth.json 缺少 access_token / refresh_token / account_id')
  }
  return { access_token, refresh_token: refresh_token || null, id_token, account_id }
}

export function normalizeAccountPoolTier(tier, credentialMode = 'refreshable') {
  const normalized = String(tier || '').trim().toLowerCase()
  if (ACCOUNT_POOL_TIERS.includes(normalized)) return normalized
  return credentialMode === 'temporary_access' ? 'disposable' : 'stable'
}

export function chatgptAccessTokenCompatibility(token) {
  try {
    const payloadSegment = String(token || '').split('.')[1]
    const payload = JSON.parse(Buffer.from(
      payloadSegment.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8'))
    const clientId = String(payload.client_id || '')
    return {
      compatible: clientId === CHATGPT_CODEX_OAUTH_CLIENT_ID,
      mode: clientId === CHATGPT_CODEX_OAUTH_CLIENT_ID
        ? 'codex_subscription'
        : 'incompatible_oauth_client',
      client_id: clientId || null
    }
  } catch {
    return {
      compatible: false,
      mode: 'unknown_oauth_client',
      client_id: null
    }
  }
}

export function addChatgptAccount(raw, label, {
  routingEnabled = undefined,
  allowAccessOnly = false,
  sourceFormat = null,
  email = null,
  planType = null,
  poolTier = null
} = {}) {
  const { access_token, refresh_token, id_token, account_id } = parseAuthJson(raw, { allowAccessOnly })
  const existing = (proxyConfig.chatgptAccounts || []).find(account => account.account_id === account_id)
  const expiresAt = decodeJwtExpiry(access_token) || (refresh_token ? Date.now() + 3600 * 1000 : null)
  if (!refresh_token && (!expiresAt || expiresAt <= Date.now() + REFRESH_SAFETY_MARGIN_MS)) {
    throw new Error('临时 Access Token 已过期或无法读取到期时间，不能导入')
  }
  const credentialMode = refresh_token ? 'refreshable' : 'temporary_access'
  const resolvedPoolTier = normalizeAccountPoolTier(
    poolTier || existing?.pool_tier,
    credentialMode
  )
  const poolTierChanged = existing && existing.pool_tier && existing.pool_tier !== resolvedPoolTier
  const nowIso = new Date().toISOString()
  const compatibility = chatgptAccessTokenCompatibility(access_token)
  const temporaryIncompatible = credentialMode === 'temporary_access' && !compatibility.compatible
  const account = {
    ...(existing || {}),
    id: existing?.id || id('acct'),
    label: label || existing?.label || account_id,
    access_token,
    refresh_token,
    id_token,
    account_id,
    expires_at: expiresAt,
    credential_mode: credentialMode,
    credential_compatibility: compatibility.mode,
    credential_source_format: sourceFormat || existing?.credential_source_format || null,
    pool_tier: resolvedPoolTier,
    pool_tier_assigned_at: poolTierChanged
      ? nowIso
      : (existing?.pool_tier_assigned_at || existing?.added_at || nowIso),
    disposable_exhausted_at: resolvedPoolTier === 'disposable'
      ? (existing?.disposable_exhausted_at || null)
      : null,
    disposable_discarded_at: resolvedPoolTier === 'disposable'
      ? (existing?.disposable_discarded_at || null)
      : null,
    disposable_last_reset_at: resolvedPoolTier === 'disposable'
      ? (existing?.disposable_last_reset_at || null)
      : null,
    discard_reason: resolvedPoolTier === 'disposable'
      ? (existing?.discard_reason || null)
      : null,
    temporary_imported_at: credentialMode === 'temporary_access'
      ? (existing?.temporary_imported_at || nowIso)
      : null,
    email: email || existing?.email || null,
    plan_type: planType || existing?.plan_type || null,
    status: temporaryIncompatible ? 'auth_error' : 'active',
    auth_error: temporaryIncompatible
      ? {
          type: 'incompatible_oauth_client',
          at: nowIso
        }
      : null,
    health_check: null,
    usage_status: existing?.usage_status || (existing?.usage_updated_at ? 'synced' : 'stale'),
    usage_error: null,
    usage_sync_status: existing?.usage_updated_at ? 'synced' : 'stale',
    usage_sync_error: null,
    reset_credit_status: existing?.reset_credit_status ||
      (existing?.reset_credit_updated_at || existing?.reset_credits?.updated_at ? 'synced' : 'stale'),
    reset_credit_updated_at: existing?.reset_credit_updated_at ||
      existing?.reset_credits?.updated_at ||
      null,
    reset_credit_error: null,
    routing_enabled: temporaryIncompatible
      ? false
      : (routingEnabled ?? existing?.routing_enabled ?? true),
    cooldown_until: null,
    last_refresh: nowIso,
    added_at: existing?.added_at || nowIso
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

export function accountCredentialLifecycle(account, now = Date.now()) {
  const mode = account?.credential_mode === 'temporary_access' ? 'temporary_access' : 'refreshable'
  const compatibility = account?.credential_compatibility ||
    (account?.access_token ? chatgptAccessTokenCompatibility(account.access_token).mode : 'codex_subscription')
  const compatible = mode !== 'temporary_access' || compatibility === 'codex_subscription'
  const expiresAt = Number(account?.expires_at)
  const remainingMs = Number.isFinite(expiresAt) ? expiresAt - now : null
  const temporary = mode === 'temporary_access'
  return {
    mode,
    temporary,
    refreshable: mode === 'refreshable',
    expires_at: Number.isFinite(expiresAt) ? expiresAt : null,
    remaining_ms: remainingMs,
    compatibility,
    compatible,
    expired: temporary && (remainingMs == null || remainingMs <= 0),
    expiring_soon: temporary && remainingMs != null && remainingMs > 0 && remainingMs <= 24 * 60 * 60 * 1000,
    routable: compatible && (!temporary || (remainingMs != null && remainingMs > REFRESH_SAFETY_MARGIN_MS))
  }
}

function timestampMs(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : null
}

function disposableQuotaRemaining(account) {
  const weekly = account?.usage?.secondary
  if (weekly?.remaining_percent != null && Number.isFinite(Number(weekly.remaining_percent))) {
    return Math.max(0, Math.min(100, Number(weekly.remaining_percent)))
  }
  if (weekly?.used_percent != null && Number.isFinite(Number(weekly.used_percent))) {
    return Math.max(0, Math.min(100, 100 - Number(weekly.used_percent)))
  }
  return accountRemainingPercent(account)
}

export function accountPoolTierState(account, now = Date.now()) {
  const credentialMode = account?.credential_mode === 'temporary_access'
    ? 'temporary_access'
    : 'refreshable'
  const tier = normalizeAccountPoolTier(account?.pool_tier, credentialMode)
  const exhaustedAt = timestampMs(account?.disposable_exhausted_at)
  const discardedAt = timestampMs(account?.disposable_discarded_at)
  const discardDeadline = exhaustedAt == null ? null : exhaustedAt + DISPOSABLE_RESET_GRACE_MS
  const disposable = tier === 'disposable'
  return {
    tier,
    stable: tier === 'stable',
    disposable,
    quota_remaining: disposable ? disposableQuotaRemaining(account) : accountRemainingPercent(account),
    exhausted: disposable && exhaustedAt != null,
    exhausted_at: exhaustedAt == null ? null : new Date(exhaustedAt).toISOString(),
    discard_deadline_at: discardDeadline == null ? null : new Date(discardDeadline).toISOString(),
    discard_remaining_ms: discardDeadline == null ? null : discardDeadline - now,
    discard_due: disposable && !discardedAt && discardDeadline != null && discardDeadline <= now,
    discarded: disposable && discardedAt != null,
    discarded_at: discardedAt == null ? null : new Date(discardedAt).toISOString(),
    discard_reason: account?.discard_reason || null
  }
}

export function enforceDisposableAccountLifecycle(account, now = Date.now()) {
  const state = accountPoolTierState(account, now)
  if (!state.disposable || state.discarded) return false
  let changed = false
  if (state.quota_remaining != null && state.quota_remaining <= 0 && !state.exhausted) {
    account.disposable_exhausted_at = new Date(now).toISOString()
    changed = true
  } else if (state.quota_remaining != null && state.quota_remaining > 0 && state.exhausted) {
    account.disposable_last_reset_at = new Date(now).toISOString()
    account.disposable_exhausted_at = null
    changed = true
  }
  const latest = accountPoolTierState(account, now)
  if (latest.discard_due) {
    account.disposable_discarded_at = new Date(now).toISOString()
    account.discard_reason = 'quota_not_reset_within_7_days'
    account.routing_enabled = false
    account.status = 'discarded'
    account.auth_error = null
    account.health_check = advanceAccountHealthState(
      account.health_check,
      accountCheckResult('discarded', {
        checkedAt: new Date(now).toISOString(),
        source: 'account_lifecycle'
      }),
      { now }
    )
    account[pendingHealthEvent] = account.health_check
    changed = true
  }
  return changed
}

export function accountUsageIsFresh(account, now = Date.now()) {
  const updatedAt = Date.parse(account?.usage_updated_at || '')
  return Number.isFinite(updatedAt) && now - updatedAt <= USAGE_FRESH_MS
}

export function classifyAccountSyncFailure(error, {
  endpoint = 'usage'
} = {}) {
  const status = Number(error?.status) || null
  const searchable = [
    error?.upstreamCode,
    error?.upstreamMessage,
    error?.message
  ].filter(Boolean).join(' ')
  const unsupported = status === 404 || (
    status === 403 &&
    /not[_ -]?(?:supported|eligible|available)|unsupported|feature[_ -]?(?:disabled|unavailable)|not entitled/i.test(searchable)
  )
  return {
    status: unsupported ? 'unsupported' : 'failed',
    error: unsupported
      ? `${endpoint === 'reset_credit' ? '重置次数' : '用量'}端点不受当前套餐支持`
      : safeErrorText(error, 300)
  }
}

export function accountSyncStates(account, now = Date.now()) {
  const effective = (stored, updatedAt, freshMs) => {
    const legacy = stored === 'error'
      ? 'failed'
      : (['pending', 'refreshing'].includes(stored) ? 'stale' : stored)
    const normalized = ['synced', 'stale', 'unsupported', 'failed'].includes(legacy)
      ? legacy
      : (updatedAt ? 'synced' : 'stale')
    if (normalized !== 'synced') return normalized
    const updated = Date.parse(updatedAt || '')
    return Number.isFinite(updated) && now - updated <= freshMs ? 'synced' : 'stale'
  }
  const usageUpdatedAt = account?.usage_updated_at || null
  const resetUpdatedAt = account?.reset_credit_updated_at ||
    account?.reset_credits?.updated_at ||
    null
  return {
    usage: effective(
      account?.usage_status || account?.usage_sync_status,
      usageUpdatedAt,
      USAGE_FRESH_MS
    ),
    reset_credit: effective(
      account?.reset_credit_status,
      resetUpdatedAt,
      RESET_CREDITS_FRESH_MS
    ),
    usage_updated_at: usageUpdatedAt,
    reset_credit_updated_at: resetUpdatedAt
  }
}

export function accountPolicyState(account, {
  model = null,
  sessionKey = null,
  globalReserve = proxyConfig.chatgptLowQuotaThreshold ?? LOW_QUOTA_THRESHOLD_PERCENT,
  now = Date.now(),
  statsSnapshot = null
} = {}) {
  const emergencyUntil = Date.parse(account?.emergency_continue_until || '')
  const emergency = Number.isFinite(emergencyUntil) && emergencyUntil > now
  const poolTier = accountPoolTierState(account, now)
  const configuredReserve = Number(account?.low_quota_threshold)
  const reserve = poolTier.disposable
    ? 0
    : (Number.isFinite(configuredReserve)
        ? Math.max(0, Math.min(100, configuredReserve))
        : Math.max(0, Math.min(100, Number(globalReserve) || 0)))
  const reservedModels = Array.isArray(account?.reserved_models) ? account.reserved_models.filter(Boolean) : []
  const reservedSessions = Array.isArray(account?.reserved_session_ids) ? account.reserved_session_ids.filter(Boolean) : []
  const hasReservation = reservedModels.length > 0 || reservedSessions.length > 0
  const reservationMatch = hasReservation && Boolean(
    (model && reservedModels.includes(model)) ||
    (sessionKey && reservedSessions.includes(sessionKey))
  )
  const snapshot = statsSnapshot || getStats()
  const daily = snapshot.daily?.[statsDayKey(now)]?.accounts?.[account?.id] || {}
  const dailyRequests = Number(daily.requests || 0)
  const dailyTokens = Number(daily.input_tokens || 0) + Number(daily.output_tokens || 0)
  const requestLimit = Math.max(0, Number(account?.daily_request_limit) || 0)
  const tokenLimit = Math.max(0, Number(account?.daily_token_limit) || 0)
  const requestLimited = requestLimit > 0 && dailyRequests >= requestLimit
  const tokenLimited = tokenLimit > 0 && dailyTokens >= tokenLimit
  return {
    emergency,
    emergency_until: emergency ? new Date(emergencyUntil).toISOString() : null,
    pool_tier: poolTier.tier,
    discarded: poolTier.discarded,
    reserve,
    has_reservation: hasReservation,
    reservation_match: reservationMatch,
    reservation_blocked: hasReservation && !reservationMatch,
    request_limited: !emergency && requestLimited,
    token_limited: !emergency && tokenLimited,
    daily_requests: dailyRequests,
    daily_tokens: dailyTokens,
    eligible: !poolTier.discarded &&
      (emergency || (!requestLimited && !tokenLimited && (!hasReservation || reservationMatch)))
  }
}

const ACCOUNT_CHECK_STATE_DETAILS = {
  healthy: {
    label: '基础检查正常',
    severity: 'healthy',
    retryable: false,
    reason: '登录凭据和用量接口均可访问；本次检查不会发送模型请求或消耗额度。'
  },
  quota_low: {
    label: '额度接近保护线',
    severity: 'warning',
    retryable: true,
    reason: '账号可以访问，但剩余额度已达到配置的安全余量。'
  },
  quota_exhausted: {
    label: '额度不足',
    severity: 'warning',
    retryable: true,
    reason: '账号额度已耗尽，需要等待额度窗口自动重置或使用有效的重置机会。'
  },
  rate_limited: {
    label: '短时限流',
    severity: 'warning',
    retryable: true,
    reason: '账号当前受到短期限流，等待 Retry-After 或冷却时间结束后再试。'
  },
  banned: {
    label: '疑似封禁或停用',
    severity: 'critical',
    retryable: false,
    reason: '上游明确返回账号已停用、封禁或暂停；需要到官方页面核实账号状态。'
  },
  auth_invalid: {
    label: '登录凭据失效',
    severity: 'critical',
    retryable: false,
    reason: 'Access Token 或 Refresh Token 已失效，需要重新完成官方登录。'
  },
  token_expired: {
    label: '临时令牌到期',
    severity: 'critical',
    retryable: false,
    reason: '临时 Access Token 已到期且没有 Refresh Token，无法自动续约。'
  },
  incompatible: {
    label: 'OAuth 权限不兼容',
    severity: 'critical',
    retryable: false,
    reason: '该 Token 不是 Codex 官方 OAuth 客户端签发，不能用于订阅 Responses 路由。'
  },
  permission_denied: {
    label: '账号权限不足',
    severity: 'critical',
    retryable: false,
    reason: '账号可以被识别，但当前套餐、地区或权限不允许访问所需服务。'
  },
  temporary_unavailable: {
    label: '暂时无法连接',
    severity: 'warning',
    retryable: true,
    reason: '网络、超时或上游服务异常导致本次检查失败，不能据此判断账号已封禁。'
  },
  discarded: {
    label: '已弃号',
    severity: 'critical',
    retryable: false,
    reason: '日抛账号在额度归零后连续 7 天未恢复，已按策略停止路由。'
  },
  unknown_error: {
    label: '未知异常',
    severity: 'warning',
    retryable: true,
    reason: '检查失败，但返回信息不足以判断是登录、额度还是网络问题。'
  }
}

function accountCheckResult(state, {
  checkedAt = new Date().toISOString(),
  reason = null,
  httpStatus = null,
  errorCode = null,
  usageSynced = false,
  resetCreditsSynced = false,
  resetCreditStatus = null,
  remainingPercent = null,
  source = 'status_check'
} = {}) {
  const details = ACCOUNT_CHECK_STATE_DETAILS[state] || ACCOUNT_CHECK_STATE_DETAILS.unknown_error
  return {
    state: ACCOUNT_CHECK_STATE_DETAILS[state] ? state : 'unknown_error',
    label: details.label,
    severity: details.severity,
    retryable: details.retryable,
    reason: reason || details.reason,
    checked_at: checkedAt,
    http_status: Number(httpStatus) || null,
    error_code: errorCode ? String(errorCode).slice(0, 80) : null,
    usage_synced: usageSynced === true,
    reset_credits_synced: resetCreditsSynced === true,
    reset_credit_status: ['synced', 'stale', 'unsupported', 'failed'].includes(resetCreditStatus)
      ? resetCreditStatus
      : (resetCreditsSynced === true ? 'synced' : 'failed'),
    remaining_percent: remainingPercent == null
      ? null
      : (Number.isFinite(Number(remainingPercent)) ? Number(remainingPercent) : null),
    source
  }
}

export function classifyAccountCheckFailure(error, account = null) {
  const credential = accountCredentialLifecycle(account || {})
  if (!credential.compatible || error?.code === 'TOKEN_OAUTH_CLIENT_INCOMPATIBLE') {
    return accountCheckResult('incompatible', {
      httpStatus: error?.status,
      errorCode: error?.upstreamCode || error?.code
    })
  }
  if (credential.expired || error?.code === 'TOKEN_TEMPORARY_ACCESS_EXPIRED') {
    return accountCheckResult('token_expired', {
      httpStatus: error?.status,
      errorCode: error?.upstreamCode || error?.code
    })
  }

  const status = Number(error?.status) || null
  const errorCode = String(error?.upstreamCode || error?.code || '').slice(0, 80)
  const searchable = [
    errorCode,
    error?.upstreamMessage,
    error?.message
  ].filter(Boolean).join(' ')
  const common = { httpStatus: status, errorCode }

  if (/account[_ -]?(?:deactivated|disabled|suspended|banned)|user[_ -]?banned|workspace[_ -]?(?:deactivated|suspended)|账号.{0,6}(?:封禁|停用|暂停)/i.test(searchable)) {
    return accountCheckResult('banned', common)
  }
  if (
    error?.code === 'TOKEN_REFRESH_RELOGIN_REQUIRED' ||
    /invalid_grant|token[_ -]?(?:expired|invalid|revoked)|authentication[_ -]?(?:failed|required)|invalid[_ -]?(?:token|auth)/i.test(searchable) ||
    status === 401
  ) {
    return accountCheckResult('auth_invalid', common)
  }
  if (
    status === 402 ||
    /insufficient[_ -]?quota|usage[_ -]?limit|plan[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|billing[_ -]?(?:limit|required)/i.test(searchable)
  ) {
    return accountCheckResult('quota_exhausted', common)
  }
  if (status === 429) {
    return accountCheckResult('rate_limited', common)
  }
  if (status === 403) {
    return accountCheckResult('permission_denied', common)
  }
  if (
    error?.code === 'TOKEN_REFRESH_TRANSIENT' ||
    error?.code === 'TOKEN_REFRESH_ACTIVE_SOURCE_STALE' ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    [408, 425, 500, 502, 503, 504].includes(status) ||
    /network|fetch failed|timeout|timed out|socket|econn|enotfound|暂时无法|网络错误/i.test(searchable)
  ) {
    return accountCheckResult('temporary_unavailable', common)
  }
  return accountCheckResult('unknown_error', common)
}

const TRANSIENT_HEALTH_STATES = new Set(['temporary_unavailable', 'unknown_error'])
const TERMINAL_HEALTH_STATES = new Set([
  'banned',
  'auth_invalid',
  'token_expired',
  'incompatible'
])
const SUCCESSFUL_PROBE_STATES = new Set(['healthy', 'quota_low', 'quota_exhausted'])

function healthConfidence(result) {
  if (result.state === 'banned') return 'high'
  if (['auth_invalid', 'token_expired', 'incompatible'].includes(result.state)) return 'high'
  if (result.state === 'permission_denied') return 'medium'
  if (['quota_low', 'quota_exhausted', 'rate_limited', 'healthy'].includes(result.state)) return 'high'
  return 'low'
}

export function advanceAccountHealthState(previous, result, {
  now = Date.now()
} = {}) {
  const checkedAt = result.checked_at || new Date(now).toISOString()
  const previousState = previous?.state === 'checking' ? null : previous?.state
  const currentTransient = TRANSIENT_HEALTH_STATES.has(result.state)
  const previousTransient = TRANSIENT_HEALTH_STATES.has(previousState)
  const successful = SUCCESSFUL_PROBE_STATES.has(result.state)
  const sameIncident = previousState === result.state ||
    (currentTransient && previousTransient)
  const consecutiveFailures = successful
    ? 0
    : (sameIncident ? Math.max(0, Number(previous?.consecutive_failures) || 0) : 0) + 1
  const recoveredFrom = successful && previousState &&
    !SUCCESSFUL_PROBE_STATES.has(previousState)
    ? previousState
    : null
  let disposition = 'observe'
  if (result.state === 'healthy') disposition = recoveredFrom ? 'recovered' : 'healthy'
  else if (result.state === 'quota_low') disposition = 'reserve_blocked'
  else if (result.state === 'quota_exhausted') disposition = 'waiting_for_reset'
  else if (result.state === 'rate_limited') disposition = 'cooldown'
  else if (TERMINAL_HEALTH_STATES.has(result.state)) disposition = 'disabled'
  else if (result.state === 'permission_denied') disposition = 'permission_review'
  else if (
    currentTransient &&
    consecutiveFailures >= TRANSIENT_HEALTH_QUARANTINE_FAILURES
  ) disposition = 'quarantined'

  let retryAt = result.retry_at || null
  if (disposition === 'quarantined' && !retryAt) {
    const exponent = Math.min(3, consecutiveFailures - TRANSIENT_HEALTH_QUARANTINE_FAILURES)
    retryAt = new Date(
      now + TRANSIENT_HEALTH_QUARANTINE_BASE_MS * Math.pow(2, exponent)
    ).toISOString()
  }
  if (disposition === 'permission_review' && !retryAt) {
    retryAt = new Date(now + 15 * 60 * 1000).toISOString()
  }

  return {
    ...result,
    checked_at: checkedAt,
    source: result.source || 'status_check',
    probe_scope: result.probe_scope || (
      result.source === 'model_request'
        ? 'model_request'
        : 'credential_usage_and_reset_credits_without_model_request'
    ),
    first_seen_at: sameIncident
      ? (previous?.first_seen_at || previous?.checked_at || checkedAt)
      : checkedAt,
    last_seen_at: checkedAt,
    consecutive_failures: consecutiveFailures,
    confidence: healthConfidence(result),
    disposition,
    retry_at: retryAt,
    recovered_from: recoveredFrom
  }
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
  const statsSnapshot = getStats()
  cleanupStickyAccounts(now)
  const eligible = []
  const reservationMatches = new Set()
  for (const account of accounts) {
    if (excludeIds && excludeIds.has(account.id)) continue
    if (enforceDisposableAccountLifecycle(account, now)) persistAccount(account)
    if (accountPoolTierState(account, now).discarded) continue
    const credential = accountCredentialLifecycle(account, now)
    if (!credential.routable) {
      const authErrorType = credential.compatible
        ? 'temporary_access_expired'
        : 'incompatible_oauth_client'
      if (account.status !== 'auth_error' || account.auth_error?.type !== authErrorType) {
        account.status = 'auth_error'
        account.auth_error = {
          type: authErrorType,
          at: new Date().toISOString()
        }
        persistAccount(account)
      }
      continue
    }
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
    const policy = accountPolicyState(account, {
      model,
      sessionKey,
      globalReserve: lowQuotaThreshold,
      now,
      statsSnapshot
    })
    if (
      (account.status === 'active' || !account.status) &&
      account.routing_enabled !== false &&
      policy.eligible &&
      (!model || !account.model_cooldowns?.[model]) &&
      accountActiveRequestCount(account.id) < accountConcurrencyLimit(account.id)
    ) {
      eligible.push(account)
      if (policy.reservation_match) reservationMatches.add(account.id)
    }
  }
  if (!eligible.length) return null
  const policyEligible = reservationMatches.size
    ? eligible.filter(account => reservationMatches.has(account.id))
    : eligible

  const scored = policyEligible.map((account, index) => {
    const policy = accountPolicyState(account, {
      model,
      sessionKey,
      globalReserve: lowQuotaThreshold,
      now,
      statsSnapshot
    })
    return {
      account,
      index,
      remaining: accountRemainingPercent(account),
      usageFresh: accountUsageIsFresh(account, now),
      reserve: policy.reserve,
      emergency: policy.emergency
    }
  })
  const freshHealthy = scored.filter(item =>
    item.emergency || (item.usageFresh && item.remaining !== null && item.remaining > item.reserve))
  const healthy = scored.filter(item =>
    item.emergency || item.remaining === null || item.remaining > item.reserve)
  // The configured threshold is a reserve, not merely a preference. Unknown
  // quota remains eligible, but a known account at/below the reserve does not.
  const candidates = freshHealthy.length ? freshHealthy : healthy
  if (!candidates.length) return null
  // Disposable accounts are intentionally consumed before touching the
  // stable subscription pool. Stable accounts therefore remain an insurance
  // fallback whenever at least one disposable account can still serve.
  const disposableCandidates = candidates.filter(item =>
    accountPoolTierState(item.account, now).disposable
  )
  const tierCandidates = disposableCandidates.length ? disposableCandidates : candidates
  return selectByStrategy(tierCandidates, normalizeAccountRoutingStrategy(strategy), sessionKey)
}

export async function ensureFreshToken(account, fetchImpl = fetch) {
  const managedByLocalCodex = proxyConfig.activeChatgptAccountId === account.id
  if (managedByLocalCodex) syncActiveAccountFromCodexHome(account)
  const credential = accountCredentialLifecycle(account)
  if (credential.temporary && !credential.compatible) {
    account.status = 'auth_error'
    account.auth_error = {
      type: 'incompatible_oauth_client',
      at: new Date().toISOString()
    }
    persistAccount(account)
    const error = new Error('该临时 Token 不是由 Codex 官方 OAuth 客户端签发，无法调用 ChatGPT Codex Responses；请完成官方登录')
    error.code = 'TOKEN_OAUTH_CLIENT_INCOMPATIBLE'
    error.retryable = false
    throw error
  }
  if (account.expires_at && account.expires_at - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
    return account
  }
  if (managedByLocalCodex) {
    const error = new Error('当前本机账号的 Token 尚未由 Codex 刷新，将暂时尝试其他账号')
    error.code = 'TOKEN_REFRESH_ACTIVE_SOURCE_STALE'
    error.retryable = true
    throw error
  }
  if (account.credential_mode === 'temporary_access' && !account.refresh_token) {
    account.status = 'auth_error'
    account.auth_error = {
      type: 'temporary_access_expired',
      at: new Date().toISOString()
    }
    persistAccount(account)
    const error = new Error('临时账号的 Access Token 已到期，无法自动续约；请移除账号或完成官方登录')
    error.code = 'TOKEN_TEMPORARY_ACCESS_EXPIRED'
    error.retryable = false
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
          client_id: CHATGPT_CODEX_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: account.refresh_token
        })
      })
    } catch (cause) {
      const error = new Error(`ChatGPT 账号 token 刷新遇到网络错误：${safeErrorText(cause)}`)
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
  let responseText = ''
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    cooldownMs = Number(retryAfter) * 1000
  }
  if (response) {
    try {
      responseText = await response.text()
      if (!retryAfter) cooldownMs = cooldownMsFromResponseText(responseText) ?? cooldownMs
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
  const check = classifyAccountCheckFailure({
    status: 429,
    upstreamMessage: responseText,
    message: 'ChatGPT account request was rate limited'
  }, account)
  check.retry_at = new Date(cooldownUntil).toISOString()
  check.source = 'model_request'
  persistAccountCheck(accountId, check)
}

export function markAccountAuthFailure(accountId, status, message = null) {
  const account = (proxyConfig.chatgptAccounts || []).find(item => item.id === accountId)
  if (!account) return
  const check = classifyAccountCheckFailure({
    status: Number(status) || null,
    upstreamMessage: message,
    message: `ChatGPT account request failed with status ${Number(status) || 0}`
  }, account)
  check.source = 'model_request'
  persistAccountCheck(accountId, check)
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

function upstreamErrorDetails(text) {
  let parsed = null
  try { parsed = JSON.parse(String(text || '')) } catch {}
  const root = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed
  const code = root?.code || root?.type || parsed?.code || parsed?.type || null
  const message = root?.message || parsed?.message || null
  return {
    code: code == null ? null : String(code).slice(0, 80),
    message: message == null ? String(text || '').slice(0, 500) : String(message).slice(0, 500)
  }
}

function responseRetryAfterMs(response, text = '') {
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return cooldownMsFromResponseText(text)
}

async function accountBackendResponseError(response, operation) {
  let text = ''
  try { text = await response.text() } catch {}
  const details = upstreamErrorDetails(text)
  const suffix = details.code ? `, code ${details.code}` : ''
  const error = new Error(`${operation}失败 (status ${response.status}${suffix})`)
  error.status = response.status
  error.upstreamCode = details.code
  error.upstreamMessage = details.message
  error.retryAfterMs = responseRetryAfterMs(response, text)
  return error
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
    throw await accountBackendResponseError(response, '获取 Codex 重置次数')
  }
  let data = null
  try { data = await response.json() } catch {}
  const parsed = extractResetCredits(data)
  if (!parsed) throw new Error('Codex 重置次数接口返回了未知格式')
  return { account: currentAccount, parsed }
}

export async function refreshAccountResetCredits(account, fetchImpl = fetch) {
  if (resetCreditsRefreshInFlight.has(account.id)) return resetCreditsRefreshInFlight.get(account.id)
  const currentAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
  const refreshPromise = (async () => {
    try {
      const result = await fetchAccountResetCredits(currentAccount, fetchImpl)
      const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || result.account
      latestAccount.reset_credits = publicResetCredits(result.parsed)
      latestAccount.reset_credit_status = 'synced'
      latestAccount.reset_credit_updated_at = latestAccount.reset_credits.updated_at
      latestAccount.reset_credit_last_attempt_at = latestAccount.reset_credits.updated_at
      latestAccount.reset_credit_error = null
      latestAccount.reset_credits_error = null
      persistAccount(latestAccount)
      return latestAccount.reset_credits
    } catch (error) {
      const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || currentAccount
      const failure = classifyAccountSyncFailure(error, { endpoint: 'reset_credit' })
      latestAccount.reset_credit_status = failure.status
      latestAccount.reset_credit_last_attempt_at = new Date().toISOString()
      latestAccount.reset_credit_error = failure.error
      latestAccount.reset_credits_error = failure.error
      persistAccount(latestAccount)
      throw error
    }
  })()
  resetCreditsRefreshInFlight.set(account.id, refreshPromise)
  try {
    return await refreshPromise
  } finally {
    if (resetCreditsRefreshInFlight.get(account.id) === refreshPromise) {
      resetCreditsRefreshInFlight.delete(account.id)
    }
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
    latestAccount.reset_credit_status = 'synced'
    latestAccount.reset_credit_updated_at = latestAccount.last_quota_reset_at
    latestAccount.reset_credit_last_attempt_at = latestAccount.last_quota_reset_at
    latestAccount.reset_credit_error = null
    latestAccount.reset_credits_error = null
    persistAccount(latestAccount)

    const refreshWarnings = []
    try {
      const refreshedAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || latestAccount
      await refreshAccountUsage(refreshedAccount, fetchImpl)
    } catch (error) {
      refreshWarnings.push(safeErrorText(error))
    }
    try {
      const refreshedAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || latestAccount
      await refreshAccountResetCredits(refreshedAccount, fetchImpl)
    } catch (error) {
      refreshWarnings.push(safeErrorText(error))
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
  enforceDisposableAccountLifecycle(account, now)
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
  account.usage_status = 'synced'
  account.usage_error = null
  account.usage_last_attempt_at = account.usage_updated_at
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
    throw await accountBackendResponseError(response, '获取账号用量')
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
  const refreshPromise = refreshAccountUsageOnce(currentAccount, fetchImpl).catch(error => {
    const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || currentAccount
    const failure = classifyAccountSyncFailure(error, { endpoint: 'usage' })
    latestAccount.usage_status = failure.status
    latestAccount.usage_error = failure.error
    latestAccount.usage_last_attempt_at = new Date().toISOString()
    latestAccount.usage_sync_status = failure.status
    latestAccount.usage_sync_error = failure.error
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

export async function refreshAccountQuotaSnapshot(account, fetchImpl = fetch) {
  let usageError = null
  let resetCreditsError = null
  try {
    await refreshAccountUsage(account, fetchImpl)
  } catch (error) {
    usageError = error
  }

  const afterUsage = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
  try {
    await refreshAccountResetCredits(afterUsage, fetchImpl)
  } catch (error) {
    resetCreditsError = error
  }

  const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || afterUsage
  const syncStates = accountSyncStates(latestAccount)
  return {
    account: latestAccount,
    usage_synced: !usageError,
    reset_credits_synced: !resetCreditsError,
    usage_status: syncStates.usage,
    reset_credit_status: syncStates.reset_credit,
    usage_error: usageError,
    reset_credits_error: resetCreditsError,
    warnings: [
      usageError
        ? `用量${syncStates.usage === 'unsupported' ? '不受支持' : '失败'}：${latestAccount.usage_error || String(usageError?.message || usageError).slice(0, 260)}`
        : null,
      resetCreditsError
        ? `重置次数${syncStates.reset_credit === 'unsupported' ? '不受支持' : '失败'}：${latestAccount.reset_credit_error || String(resetCreditsError?.message || resetCreditsError).slice(0, 260)}`
        : null
    ].filter(Boolean)
  }
}

function successfulAccountCheckState(account, snapshot, checkedAt) {
  const remaining = accountRemainingPercent(account)
  const policy = accountPolicyState(account)
  const poolTier = accountPoolTierState(account)
  const resetWarning = snapshot.reset_credits_synced
    ? null
    : snapshot.reset_credit_status === 'unsupported'
      ? '账号用量检查成功，但当前套餐不支持重置次数端点。'
      : '账号用量检查成功，但重置次数查询失败；界面会保留上次次数并标明查询错误。'
  const reasonWithResetWarning = state => resetWarning
    ? `${ACCOUNT_CHECK_STATE_DETAILS[state].reason} ${resetWarning}`
    : null
  const common = {
    checkedAt,
    usageSynced: true,
    resetCreditsSynced: snapshot.reset_credits_synced,
    resetCreditStatus: snapshot.reset_credit_status,
    remainingPercent: remaining
  }

  if (poolTier.discarded) return accountCheckResult('discarded', common)
  if (remaining != null && remaining <= 0) {
    return accountCheckResult('quota_exhausted', {
      ...common,
      reason: reasonWithResetWarning('quota_exhausted')
    })
  }
  if (account.status === 'auth_error') {
    const status = Number(account.auth_error?.status) || null
    const type = String(account.auth_error?.type || '')
    if (/incompatible_oauth_client/.test(type)) return accountCheckResult('incompatible', common)
    if (/temporary_access_expired/.test(type)) return accountCheckResult('token_expired', common)
    if (/banned|deactivated|disabled|suspended/.test(type)) {
      return accountCheckResult('banned', {
        ...common,
        httpStatus: status,
        errorCode: type
      })
    }
    if (status === 403) {
      return accountCheckResult('permission_denied', {
        ...common,
        httpStatus: status,
        errorCode: type,
        reason: '用量接口可以访问，但最近一次模型路由返回 HTTP 403；请核对账号套餐、地区和服务权限。'
      })
    }
    return accountCheckResult('auth_invalid', {
      ...common,
      httpStatus: status,
      errorCode: type,
      reason: '用量接口可以访问，但账号仍保留最近一次模型路由的鉴权失败状态；建议重新官方登录后再检查。'
    })
  }
  if (
    account.status === 'cooldown' &&
    Number(account.cooldown_until) > Date.now() &&
    !String(account.last_cooldown_reason || '').startsWith('health_check_')
  ) {
    return accountCheckResult('rate_limited', common)
  }
  if (remaining != null && remaining <= policy.reserve) {
    return accountCheckResult('quota_low', {
      ...common,
      reason: reasonWithResetWarning('quota_low')
    })
  }
  return accountCheckResult('healthy', {
    ...common,
    reason: reasonWithResetWarning('healthy')
  })
}

function persistAccountCheck(accountId, result) {
  const latestAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === accountId)
  if (!latestAccount) return result
  const previous = latestAccount.health_check || null
  const health = advanceAccountHealthState(previous, result)
  latestAccount.health_check = health
  if (health.disposition === 'disabled') {
    latestAccount.status = 'auth_error'
    latestAccount.auth_error = {
      type: `health_check_${health.state}`,
      status: health.http_status,
      at: health.checked_at
    }
  } else if (['quarantined', 'permission_review'].includes(health.disposition)) {
    const retryAt = Date.parse(health.retry_at || '')
    latestAccount.status = 'cooldown'
    latestAccount.cooldown_until = Number.isFinite(retryAt)
      ? retryAt
      : Date.now() + DEFAULT_COOLDOWN_MS
    latestAccount.last_cooldown_reason = `health_check_${health.state}`
  } else if (health.disposition === 'cooldown') {
    const retryAt = Date.parse(health.retry_at || '')
    latestAccount.status = 'cooldown'
    latestAccount.cooldown_until = Number.isFinite(retryAt)
      ? retryAt
      : Date.now() + DEFAULT_COOLDOWN_MS
    latestAccount.last_cooldown_reason = 'rate_limit'
  } else if (
    health.disposition === 'waiting_for_reset' &&
    health.usage_synced !== true
  ) {
    const retryAt = Date.parse(health.retry_at || '')
    latestAccount.status = 'cooldown'
    latestAccount.cooldown_until = Number.isFinite(retryAt)
      ? retryAt
      : Date.now() + DEFAULT_COOLDOWN_MS
    latestAccount.last_cooldown_reason = 'health_check_quota_exhausted'
  } else if (
    ['healthy', 'recovered', 'reserve_blocked', 'waiting_for_reset'].includes(health.disposition) &&
    latestAccount.status === 'cooldown' &&
    String(latestAccount.last_cooldown_reason || '').startsWith('health_check_')
  ) {
    latestAccount.status = 'active'
    latestAccount.cooldown_until = null
    latestAccount.last_cooldown_reason = null
  }
  persistAccount(latestAccount)
  recordAccountHealthEvent(latestAccount, health)
  return health
}

export async function checkChatgptAccountStatus(account, fetchImpl = fetch) {
  if (accountStatusCheckInFlight.has(account.id)) return accountStatusCheckInFlight.get(account.id)
  const checkPromise = (async () => {
    const checkedAt = new Date().toISOString()
    const currentAccount = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
    const credential = accountCredentialLifecycle(currentAccount)
    const poolTier = accountPoolTierState(currentAccount)

    if (poolTier.discarded) {
      return persistAccountCheck(account.id, accountCheckResult('discarded', { checkedAt }))
    }
    if (!credential.compatible) {
      return persistAccountCheck(account.id, accountCheckResult('incompatible', { checkedAt }))
    }
    if (credential.expired) {
      return persistAccountCheck(account.id, accountCheckResult('token_expired', { checkedAt }))
    }

    const latestBeforeRefresh = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || currentAccount
    const snapshot = await refreshAccountQuotaSnapshot(latestBeforeRefresh, fetchImpl)
    if (!snapshot.usage_synced) {
      const result = classifyAccountCheckFailure(snapshot.usage_error, snapshot.account)
      result.checked_at = checkedAt
      result.reset_credits_synced = snapshot.reset_credits_synced
      result.reset_credit_status = snapshot.reset_credit_status
      if (['quota_exhausted', 'rate_limited'].includes(result.state)) {
        const retryMs = Number(snapshot.usage_error?.retryAfterMs)
        result.retry_at = new Date(
          Date.now() + (Number.isFinite(retryMs)
            ? Math.max(1000, Math.min(retryMs, MAX_REASONABLE_COOLDOWN_MS))
            : DEFAULT_COOLDOWN_MS)
        ).toISOString()
      }
      return persistAccountCheck(account.id, result)
    }
    return persistAccountCheck(
      account.id,
      successfulAccountCheckState(snapshot.account, snapshot, checkedAt)
    )
  })()
  accountStatusCheckInFlight.set(account.id, checkPromise)
  try {
    return await checkPromise
  } finally {
    if (accountStatusCheckInFlight.get(account.id) === checkPromise) {
      accountStatusCheckInFlight.delete(account.id)
    }
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
      console.error(
        '[codex-proxy] usage refresh failed for %s: %s',
        account.label || account.id,
        safeErrorText(error)
      )
    }
    await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)))
  }
}

async function refreshAllResetCreditsQuiet() {
  for (const account of (proxyConfig.chatgptAccounts || [])) {
    try {
      await refreshAccountResetCredits(account, chinaFetch(fetch))
    } catch (error) {
      const latest = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
      if (latest.reset_credit_status !== 'unsupported') {
        console.warn(
          '[codex-proxy] reset-credit refresh failed for %s: %s',
          account.label || account.id,
          safeErrorText(error)
        )
      }
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
    console.error(
      '[codex-proxy] active-account usage refresh failed: %s',
      safeErrorText(error)
    )
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
    if (enforceDisposableAccountLifecycle(account, now)) changed = true
    const syncStates = accountSyncStates(account, now)
    if (account.usage_status !== syncStates.usage) {
      account.usage_status = syncStates.usage
      account.usage_sync_status = syncStates.usage
      changed = true
    }
    if (account.usage_error === undefined) {
      account.usage_error = account.usage_sync_error || null
      changed = true
    }
    if (account.reset_credit_status !== syncStates.reset_credit) {
      account.reset_credit_status = syncStates.reset_credit
      changed = true
    }
    if (account.reset_credit_updated_at === undefined) {
      account.reset_credit_updated_at = syncStates.reset_credit_updated_at
      changed = true
    }
    if (account.reset_credit_error === undefined) {
      account.reset_credit_error = account.reset_credits_error || null
      changed = true
    }
    const credential = accountCredentialLifecycle(account, now)
    if (credential.temporary && !credential.compatible) {
      if (account.credential_compatibility !== credential.compatibility) {
        account.credential_compatibility = credential.compatibility
        changed = true
      }
      if (account.status !== 'auth_error' || account.auth_error?.type !== 'incompatible_oauth_client') {
        account.status = 'auth_error'
        account.auth_error = {
          type: 'incompatible_oauth_client',
          at: new Date().toISOString()
        }
        changed = true
      }
      if (account.routing_enabled !== false) {
        account.routing_enabled = false
        changed = true
      }
    } else if (credential.expired) {
      if (account.status !== 'auth_error' || account.auth_error?.type !== 'temporary_access_expired') {
        account.status = 'auth_error'
        account.auth_error = {
          type: 'temporary_access_expired',
          at: new Date().toISOString()
        }
        changed = true
      }
      if (account.routing_enabled !== false) {
        account.routing_enabled = false
        changed = true
      }
    }
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
      reset_credits_refresh_in_flight: resetCreditsRefreshInFlight.has(account.id),
      status_check_in_flight: accountStatusCheckInFlight.has(account.id),
      remaining_percent: accountRemainingPercent(account),
      cooldown_until: account.cooldown_until || null,
      model_cooldowns: Object.keys(account.model_cooldowns || {}).length,
      usage_forecast: account.usage_forecast || null,
      sync_states: accountSyncStates(account),
      health_check: account.health_check || null,
      credential: accountCredentialLifecycle(account),
      pool_tier: accountPoolTierState(account)
    }
  })
}

// Stable-mode refresh policy: prefer quota headers from real responses,
// refresh enabled accounts every ~30 minutes with jitter, and refresh the
// current account no more than every ~5 minutes. Failures back off exponentially.
if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  repairAccountRuntimeState()
  setInterval(() => repairAccountRuntimeState(), 60_000).unref()
  scheduleWithJitter(refreshAllUsageQuiet, GLOBAL_USAGE_REFRESH_MS)
  scheduleWithJitter(refreshAllResetCreditsQuiet, RESET_CREDITS_REFRESH_MS)
  scheduleWithJitter(refreshActiveUsageQuiet, ACTIVE_USAGE_REFRESH_MS)
}
