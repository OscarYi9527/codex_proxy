// ChatGPT Subscription route handler
// Handles gpt-* models via ChatGPT backend (uses Codex auth headers)

import { proxyConfig } from '../config.js'
import { requestLog } from '../logger.js'
import { sendJson, pipeResponsesUpstream, fetchWithRetry, setProxyMeta } from '../server-utils.js'
import { recordUsage, recordAccountOutcome, recordOperationalEvent, saveStats } from '../stats.js'
import { chinaFetch, withChinaDispatcher } from '../china-fetch.js'
import { pickActiveAccount, ensureFreshToken, markAccountCooldown, markAccountAuthFailure, extractUsageFromHeaders, applyAccountUsage, accountSessionKey, noteAccountSuccess, reserveAccountRequest, renewAccountRequestLease, releaseAccountRequest, accountActiveRequestCount, accountConcurrencyLimit, accountRemainingPercent, accountPolicyState, noteAccountAdaptiveOutcome, refreshAccountUsage } from '../chatgpt-accounts.js'
import { recordRouteDecision } from '../route-decisions.js'

const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'
const responsesLiteUnsupportedModels = new Set()
const MAX_ACCOUNT_ATTEMPTS_PER_REQUEST = 2
const ACCOUNT_POOL_UNAVAILABLE_MESSAGE = 'No ChatGPT account became available before the local queue timeout. Check Admin > Account Pool: enable an account with quota, refresh expired login, or wait for cooldown/busy requests.'
// When all enabled accounts are temporarily busy, wait rather than failing
// fast. This avoids false 503s on short request overlap.
const BUSY_ACCOUNT_RETRY_MS = 500
const BUSY_ACCOUNT_RETRY_COUNT = 120
const QUOTA_RECHECK_MIN_AGE_MS = 2 * 60 * 1000
const accountWaitQueue = []

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function upstreamSignalFor(req) {
  if (req.proxyUpstreamSignal) return req.proxyUpstreamSignal
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Upstream request timed out')), 300_000)
  timer.unref()
  const abort = () => controller.abort(new Error('Client disconnected'))
  req.once('aborted', abort)
  req.clientAbortSignal?.addEventListener('abort', abort, { once: true })
  req.proxyUpstreamSignal = controller.signal
  req.cleanupProxyUpstreamSignal = () => {
    clearTimeout(timer)
    req.off('aborted', abort)
    req.clientAbortSignal?.removeEventListener('abort', abort)
  }
  return controller.signal
}

function hasBusyEnabledAccount(model, excludeIds = null) {
  return (proxyConfig.chatgptAccounts || []).some(account =>
    (!excludeIds || !excludeIds.has(account.id)) &&
    account.routing_enabled !== false &&
    (account.status === 'active' || !account.status) &&
    (!model || !account.model_cooldowns?.[model]) &&
    accountActiveRequestCount(account.id) >= accountConcurrencyLimit(account.id)
  )
}

function accountDecisionDetails(model, excludeIds, selectedId = null) {
  const now = Date.now()
  const threshold = Number(proxyConfig.chatgptLowQuotaThreshold ?? 10)
  return (proxyConfig.chatgptAccounts || []).map(account => {
    const remaining = accountRemainingPercent(account)
    let result = 'skipped'
    let reason = '未被当前策略选中'
    if (account.id === selectedId) {
      result = 'selected'
      reason = '已选择'
    } else if (excludeIds?.has(account.id)) {
      reason = '本次请求已经尝试过'
    } else if (account.routing_enabled === false) {
      reason = '仅保存，未启用路由'
    } else if (account.status === 'auth_error') {
      reason = '登录凭据已失效'
    } else if (account.status === 'cooldown' && Number(account.cooldown_until) > now) {
      reason = '账号冷却中'
    } else if (account.status && account.status !== 'active') {
      reason = `账号状态：${account.status}`
    } else if (model && Number(account.model_cooldowns?.[model]) > now) {
      reason = '当前模型冷却中'
    } else if (remaining !== null && remaining <= threshold) {
      reason = `剩余额度 ${remaining}% 已到安全线 ${threshold}%`
    } else if (accountActiveRequestCount(account.id) >= accountConcurrencyLimit(account.id)) {
      reason = '并发已满，等待空闲'
    } else {
      result = 'eligible'
      reason = '可用，但未被当前策略选中'
    }
    return {
      id: account.id,
      label: account.label || account.account_id || account.id,
      result,
      reason,
      remainingPercent: remaining
    }
  })
}

export async function refreshBelowReserveAccounts(
  fetchImpl,
  model,
  excludeIds = null,
  refreshImpl = refreshAccountUsage
) {
  const now = Date.now()
  const threshold = Number(proxyConfig.chatgptLowQuotaThreshold ?? 10)
  const candidates = (proxyConfig.chatgptAccounts || []).filter(account => {
    if (excludeIds?.has(account.id)) return false
    if (account.routing_enabled === false) return false
    if (account.status && account.status !== 'active') return false
    if (model && Number(account.model_cooldowns?.[model]) > now) return false
    const remaining = accountRemainingPercent(account)
    if (remaining === null || remaining > threshold) return false
    const updatedAt = Date.parse(account.usage_updated_at || '')
    return !Number.isFinite(updatedAt) || now - updatedAt >= QUOTA_RECHECK_MIN_AGE_MS
  })
  if (!candidates.length) return false

  for (const account of candidates) {
    try {
      await refreshImpl(account, fetchImpl)
    } catch (error) {
      console.warn('[codex-proxy] on-demand quota refresh failed for %s: %s',
        account.label || account.id, error.message)
    }
  }
  return true
}

// Selection and reservation must be one operation. Previously every waiter
// could select the same newly-free account, then all but one failed reserve;
// because that account had already been added to `tried`, those requests
// waited for a minute and eventually returned a false 503.
export async function acquireActiveAccountWithRetry(
  req,
  model,
  tried = null,
  sessionKey = null,
  fetchImpl = fetch,
  {
    retryMs = BUSY_ACCOUNT_RETRY_MS,
    retryCount = BUSY_ACCOUNT_RETRY_COUNT
  } = {}
) {
  const effectiveSessionKey = sessionKey || accountSessionKey(req)
  const ticket = {
    id: req.requestId || `queue_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    sessionKey: effectiveSessionKey,
    enqueuedAt: Date.now()
  }
  accountWaitQueue.push(ticket)
  let maxPosition = accountWaitQueue.length
  let quotaRefreshAttempted = false
  try {
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const position = accountWaitQueue.indexOf(ticket)
      maxPosition = Math.max(maxPosition, position + 1)
      if (position === 0) {
        const account = pickActiveAccount(tried, { sessionKey: effectiveSessionKey, model })
        if (account && reserveAccountRequest(account.id, ticket.id)) {
          accountWaitQueue.shift()
          req.accountLeaseId = ticket.id
          req.accountQueueMeta = {
            waitedMs: Date.now() - ticket.enqueuedAt,
            maxPosition
          }
          recordRouteDecision({
            requestId: req.requestId,
            model,
            provider: 'chatgpt-sub',
            selectedAccountId: account.id,
            selectedAccountLabel: account.label || account.account_id,
            queueWaitMs: req.accountQueueMeta.waitedMs,
            accounts: accountDecisionDetails(model, tried, account.id)
          })
          return account
        }
        if (!hasBusyEnabledAccount(model, tried)) {
          if (!quotaRefreshAttempted) {
            quotaRefreshAttempted = true
            if (await refreshBelowReserveAccounts(fetchImpl, model, tried)) continue
          }
          recordRouteDecision({
            requestId: req.requestId,
            model,
            provider: 'chatgpt-sub',
            outcome: 'unavailable',
            queueWaitMs: Date.now() - ticket.enqueuedAt,
            accounts: accountDecisionDetails(model, tried)
          })
          return null
        }
      }
      if (attempt === retryCount || req.aborted) {
        recordRouteDecision({
          requestId: req.requestId,
          model,
          provider: 'chatgpt-sub',
          outcome: req.aborted ? 'client_disconnected' : 'queue_timeout',
          queueWaitMs: Date.now() - ticket.enqueuedAt,
          accounts: accountDecisionDetails(model, tried)
        })
        return null
      }
      await sleep(retryMs)
    }
  } finally {
    const index = accountWaitQueue.indexOf(ticket)
    if (index >= 0) accountWaitQueue.splice(index, 1)
  }
  return null
}

export function getAccountQueueDiagnostics() {
  return {
    depth: accountWaitQueue.length,
    oldest_wait_ms: accountWaitQueue.length
      ? Date.now() - accountWaitQueue[0].enqueuedAt
      : 0,
    sessions: new Set(accountWaitQueue.map(item => item.sessionKey).filter(Boolean)).size
  }
}

function chatGptHeaders(req, { includeResponsesLite = true } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
  const forwarded = [
    'authorization', 'chatgpt-account-id', 'originator', 'session-id',
    'thread-id', 'user-agent', 'x-client-request-id', 'x-codex-beta-features',
    'x-codex-turn-metadata', 'x-codex-window-id'
  ]
  if (includeResponsesLite) forwarded.push(RESPONSES_LITE_HEADER)
  for (const name of forwarded) {
    const value = req.headers[name]
    if (value) headers[name] = value
  }
  return headers
}

// Same forwarded headers as chatGptHeaders, but authorization / chatgpt-account-id
// come from the account-pool account instead of the client's own Codex session.
function buildAccountPoolHeaders(req, account, opts) {
  const headers = chatGptHeaders(req, opts)
  headers.authorization = `Bearer ${account.access_token}`
  headers['chatgpt-account-id'] = account.account_id
  return headers
}

async function rateLimitScope(response) {
  let text = ''
  try { text = await response.clone().text() } catch {}
  return /insufficient_quota|usage_limit|plan_limit|account[_ -]?(?:rate|usage|quota)|billing/i.test(text)
    ? 'account'
    : 'model'
}

// Sends the request using the account pool, rotating to the next account on
// a 429 and retrying the same request. Stops after cycling the whole pool so
// an all-accounts-exhausted request can't loop forever; in that case the last
// (still-429) upstream response is returned unchanged for passthrough to the client.
export async function sendWithAccountRotation(
  req,
  chatGptFetch,
  upstreamBody,
  { model, tryResponsesLite },
  {
    acquireAccount = acquireActiveAccountWithRetry,
    ensureToken = ensureFreshToken,
    fetchRetry = fetchWithRetry,
    markCooldown = markAccountCooldown,
    markAuthFailure = markAccountAuthFailure,
    releaseAccount = releaseAccountRequest
  } = {}
) {
  const tried = new Set()
  const sessionKey = accountSessionKey(req)
  let account = await acquireAccount(req, model, null, sessionKey, chatGptFetch)
  const poolSize = (proxyConfig.chatgptAccounts || []).length
  let includeResponsesLite = tryResponsesLite
  let attempts = 0
  let last = null
  let lastError = null

  while (account && attempts < Math.min(poolSize, MAX_ACCOUNT_ATTEMPTS_PER_REQUEST)) {
    attempts++
    tried.add(account.id)
    const attemptStartedAt = Date.now()
    try {
      await ensureToken(account, chatGptFetch)

      const options = withChinaDispatcher({
        method: 'POST',
        headers: buildAccountPoolHeaders(req, account, { includeResponsesLite }),
        body: upstreamBody,
        signal: upstreamSignalFor(req),
        circuitKey: 'chatgpt-sub',
        // Let account rotation handle quota responses immediately rather than
        // retrying a known-limited account.
        retryStatuses: [502, 503, 504]
      })
      let upstream = await fetchRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, options, 2)

      if (includeResponsesLite && await isResponsesLiteUnsupported(upstream)) {
        responsesLiteUnsupportedModels.add(model)
        includeResponsesLite = false
        await upstream.body?.cancel()
        upstream = await fetchRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, {
          ...options,
          headers: buildAccountPoolHeaders(req, account, { includeResponsesLite }),
          signal: upstreamSignalFor(req)
        }, 2)
      }

      last = { upstream, account }
      recordAccountOutcome(account.id, {
        status: upstream.status,
        latencyMs: Date.now() - attemptStartedAt,
        errorType: upstream.status === 429 ? 'rate_limit' : (upstream.status >= 400 ? 'upstream' : null)
      })
      noteAccountAdaptiveOutcome(account.id, {
        status: upstream.status,
        latencyMs: Date.now() - attemptStartedAt
      })
      if (upstream.status === 429) {
        const scope = await rateLimitScope(upstream)
        requestLog(req, `chatgpt-account=${account.id} status=429 cooldown_scope=${scope} rotate`)
        await markCooldown(account.id, upstream.clone(), { model, scope })
        releaseAccount(account.id, req.accountLeaseId)
        const previousAccountId = account.id
        account = await acquireAccount(req, model, tried, sessionKey, chatGptFetch)
        if (account) recordOperationalEvent('account_switch', {
          provider: 'chatgpt-sub',
          fromAccountId: previousAccountId,
          toAccountId: account.id,
          reason: '429'
        })
        continue
      }
      if (upstream.status === 401 || upstream.status === 403) {
        markAuthFailure(account.id, upstream.status)
        releaseAccount(account.id, req.accountLeaseId)
        const previousAccountId = account.id
        account = await acquireAccount(req, model, tried, sessionKey, chatGptFetch)
        if (account) recordOperationalEvent('account_switch', {
          provider: 'chatgpt-sub',
          fromAccountId: previousAccountId,
          toAccountId: account.id,
          reason: String(upstream.status)
        })
        continue
      }

      requestLog(req, `chatgpt-account=${account.id} status=${upstream.status}`)
      const usage = extractUsageFromHeaders(upstream.headers)
      if (usage) applyAccountUsage(account.id, usage)
      if (upstream.ok) noteAccountSuccess(sessionKey, account.id)
      return {
        ...last,
        attempts,
        queueWaitMs: req.accountQueueMeta?.waitedMs || 0,
        queuePosition: req.accountQueueMeta?.maxPosition || 1,
        reservedAccountId: account.id
      }
    } catch (error) {
      releaseAccount(account.id, req.accountLeaseId)
      lastError = error
      const errorType = error.code === 'CIRCUIT_OPEN'
        ? 'circuit_open'
        : (error.code?.startsWith('TOKEN_REFRESH_') ? 'token_refresh' : 'network')
      recordAccountOutcome(account.id, {
        latencyMs: Date.now() - attemptStartedAt,
        errorType,
        errorMessage: error.message
      })
      noteAccountAdaptiveOutcome(account.id, {
        errorType: error.retryable === false ? 'authentication' : 'network',
        latencyMs: Date.now() - attemptStartedAt
      })
      requestLog(req, `chatgpt-account=${account.id} network_error=${error.message} rotate`)
      const previousAccountId = account.id
      account = await acquireAccount(req, model, tried, sessionKey, chatGptFetch)
      if (account) recordOperationalEvent('account_switch', {
        provider: 'chatgpt-sub',
        fromAccountId: previousAccountId,
        toAccountId: account.id,
        reason: errorType
      })
    }
  }

  if (!last && lastError) {
    lastError.accountAttempts = attempts
    lastError.accountPoolExhausted = attempts >= MAX_ACCOUNT_ATTEMPTS_PER_REQUEST
    throw lastError
  }
  return last ? { ...last, attempts, reservedAccountId: null } : null
}

async function isResponsesLiteUnsupported(response) {
  if (response.status !== 400) return false
  let text
  try { text = await response.clone().text() } catch { return false }
  if (!/responses-lite|x-openai-internal-codex-responses-lite/i.test(text)) return false
  try {
    const payload = JSON.parse(text)
    const error = payload?.error || payload
    return error?.code === 'unsupported_value' || /not supported|unsupported/i.test(error?.message || '')
  } catch {
    return /not supported|unsupported_value/i.test(text)
  }
}

function hasEnabledAccountPool() {
  return (proxyConfig.chatgptAccounts || []).some(account => account.routing_enabled !== false)
}

export function poolAvailabilityDetails(model) {
  const now = Date.now()
  const threshold = Number(proxyConfig.chatgptLowQuotaThreshold ?? 10)
  const details = {
    total: (proxyConfig.chatgptAccounts || []).length,
    enabled: 0,
    stored_only: 0,
    auth_error: 0,
    busy: 0,
    cooling: 0,
    model_cooling: 0,
    below_reserve: 0,
    daily_limited: 0,
    reserved_for_other_work: 0,
    emergency_continue: 0,
    eligible: 0
  }
  for (const account of (proxyConfig.chatgptAccounts || [])) {
    if (account.routing_enabled === false) {
      details.stored_only++
      continue
    }
    details.enabled++
    if (account.status === 'auth_error') details.auth_error++
    else if (account.status === 'cooldown' && Number(account.cooldown_until) > now) details.cooling++
    else if (model && Number(account.model_cooldowns?.[model]) > now) details.model_cooling++
    else {
      const policy = accountPolicyState(account, { model, globalReserve: threshold, now })
      const remaining = accountRemainingPercent(account)
      if (!policy.emergency && (policy.request_limited || policy.token_limited)) details.daily_limited++
      else if (!policy.emergency && policy.reservation_blocked) details.reserved_for_other_work++
      else if (!policy.emergency && remaining !== null && remaining <= policy.reserve) details.below_reserve++
      else if (accountActiveRequestCount(account.id) >= accountConcurrencyLimit(account.id)) details.busy++
      else {
        if (policy.emergency) details.emergency_continue++
        details.eligible++
      }
    }
  }
  return details
}

export async function handleChatGptSub(req, res, body, resolved, {
  sendWithRotation = sendWithAccountRotation
} = {}) {
  setProxyMeta(res, { provider: 'chatgpt-sub', model: resolved.model })
  requestLog(req, `model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} effort=${resolved.reasoningEffort || '-'}`)

  const useAccountPool = hasEnabledAccountPool()
  if (!useAccountPool && (!req.headers.authorization || !req.headers['chatgpt-account-id'])) {
    return sendJson(res, 401, {
      error: { type: 'authentication_error', message: 'ChatGPT subscription headers were not provided by Codex' }
    })
  }

  const upstreamBody = JSON.stringify({
    ...body,
    model: resolved.model,
    ...(resolved.reasoningEffort ? { reasoning: { ...(body.reasoning || {}), effort: resolved.reasoningEffort } } : {})
  })

  const requestedResponsesLite = Boolean(req.headers[RESPONSES_LITE_HEADER])
  const tryResponsesLite = requestedResponsesLite && !responsesLiteUnsupportedModels.has(resolved.model)
  const chatGptFetch = chinaFetch(req.fetchImpl)

  let upstream
  let leaseRenewal = null
  if (useAccountPool) {
    let result
    try {
      result = await sendWithRotation(req, chatGptFetch, upstreamBody, { model: resolved.model, tryResponsesLite })
    } catch (error) {
      if (error.accountPoolExhausted) {
        const details = {
          ...poolAvailabilityDetails(resolved.model),
          account_attempts: Number(error.accountAttempts) || MAX_ACCOUNT_ATTEMPTS_PER_REQUEST,
          last_error: error.message
        }
        requestLog(req, `account_pool_attempts_exhausted details=${JSON.stringify(details)}`)
        return sendJson(res, 503, {
          error: {
            type: 'account_pool_attempts_exhausted',
            message: `Two ChatGPT account attempts failed. Check account login, network, cooldown, and recent route decisions. Last error: ${error.message}`,
            details
          }
        }, { 'retry-after': '3' })
      }
      throw error
    }
    if (!result) {
      const details = poolAvailabilityDetails(resolved.model)
      requestLog(req, `account_pool_unavailable details=${JSON.stringify(details)}`)
      return sendJson(res, 503, {
        error: {
          type: 'account_pool_exhausted',
          message: ACCOUNT_POOL_UNAVAILABLE_MESSAGE,
          details
        }
      }, { 'retry-after': '3' })
    }
    upstream = result.upstream
    setProxyMeta(res, {
      accountId: result.account.id,
      fallbackAttempts: Math.max(0, result.attempts - 1),
      queueWaitMs: result.queueWaitMs,
      queuePosition: result.queuePosition
    })
    leaseRenewal = setInterval(
      () => renewAccountRequestLease(result.account.id, req.accountLeaseId),
      60_000
    )
    leaseRenewal.unref()
  } else {
    const upstreamOptions = withChinaDispatcher({
      method: 'POST',
      headers: chatGptHeaders(req, { includeResponsesLite: tryResponsesLite }),
      body: upstreamBody,
      signal: upstreamSignalFor(req),
      circuitKey: 'chatgpt-sub'
    })

    upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, upstreamOptions)

    if (tryResponsesLite && await isResponsesLiteUnsupported(upstream)) {
      responsesLiteUnsupportedModels.add(resolved.model)
      requestLog(req, `model=${resolved.model} responses_lite=unsupported retry=standard`)
      await upstream.body?.cancel()
      upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, {
        ...upstreamOptions,
        headers: chatGptHeaders(req, { includeResponsesLite: false }),
        signal: upstreamSignalFor(req)
      })
    }
  }

  try {
    return await pipeResponsesUpstream(upstream, res, {
      onBody: (u) => {
        recordUsage(resolved.model, 'chatgpt-sub', u.input_tokens, u.output_tokens, res.proxyMeta?.accountId)
        saveStats()
      }
    })
  } finally {
    req.cleanupProxyUpstreamSignal?.()
    if (leaseRenewal) clearInterval(leaseRenewal)
    if (useAccountPool) releaseAccountRequest(res.proxyMeta?.accountId, req.accountLeaseId)
  }
}

// Used by /v1/chat/completions fallback for subscription models
export async function handleChatGptSubChatCompletions(req, res, body, resolved) {
  setProxyMeta(res, { provider: 'chatgpt-sub', model: resolved.model })
  requestLog(req, `chat-completions model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} effort=${resolved.reasoningEffort || '-'}`)

  const useAccountPool = hasEnabledAccountPool()
  if (!useAccountPool && (!req.headers.authorization || !req.headers['chatgpt-account-id'])) {
    return sendJson(res, 401, {
      error: { type: 'authentication_error', message: 'ChatGPT subscription headers were not provided by Codex' }
    })
  }

  const upstreamBody = JSON.stringify({ ...body, model: resolved.model })
  const chatGptFetch = chinaFetch(req.fetchImpl)

  let upstream
  let leaseRenewal = null
  if (useAccountPool) {
    const result = await sendWithAccountRotation(req, chatGptFetch, upstreamBody, { model: resolved.model, tryResponsesLite: false })
    if (!result) {
      const details = poolAvailabilityDetails(resolved.model)
      requestLog(req, `account_pool_unavailable details=${JSON.stringify(details)}`)
      return sendJson(res, 503, {
        error: {
          type: 'account_pool_exhausted',
          message: ACCOUNT_POOL_UNAVAILABLE_MESSAGE,
          details
        }
      }, { 'retry-after': '3' })
    }
    upstream = result.upstream
    setProxyMeta(res, {
      accountId: result.account.id,
      fallbackAttempts: Math.max(0, result.attempts - 1),
      queueWaitMs: result.queueWaitMs,
      queuePosition: result.queuePosition
    })
    leaseRenewal = setInterval(
      () => renewAccountRequestLease(result.account.id, req.accountLeaseId),
      60_000
    )
    leaseRenewal.unref()
  } else {
    const upstreamOptions = withChinaDispatcher({
      method: 'POST',
      headers: chatGptHeaders(req, { includeResponsesLite: false }),
      body: upstreamBody,
      signal: upstreamSignalFor(req),
      circuitKey: 'chatgpt-sub'
    })
    upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, upstreamOptions)
  }

  try {
    return await pipeResponsesUpstream(upstream, res, {
      onBody: (u) => {
        recordUsage(resolved.model, 'chatgpt-sub', u.input_tokens, u.output_tokens, res.proxyMeta?.accountId)
        saveStats()
      }
    })
  } finally {
    req.cleanupProxyUpstreamSignal?.()
    if (leaseRenewal) clearInterval(leaseRenewal)
    if (useAccountPool) releaseAccountRequest(res.proxyMeta?.accountId, req.accountLeaseId)
  }
}
