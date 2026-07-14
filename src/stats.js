// Usage statistics accumulator
import fs from 'fs'
import path from 'path'
import { PROXY_DIR, atomicWriteJson } from './config.js'

const STATS_FILE = path.join(PROXY_DIR, '..', 'codex-proxy-stats.json')
const DAILY_RETENTION_DAYS = 370
let stats = { updated: new Date().toISOString(), providers: {}, accounts: {}, daily: {} }

export function statsDayKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const part = type => parts.find(item => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function pruneDaily(now = Date.now()) {
  stats.daily ||= {}
  const cutoff = statsDayKey(now - DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  for (const key of Object.keys(stats.daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < cutoff) delete stats.daily[key]
  }
}

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stats = parsed
      stats.updated = stats.updated || new Date().toISOString()
      stats.providers ||= {}
      stats.accounts ||= {}
      stats.daily ||= {}
      pruneDaily()
      return
    }
  } catch {}
  stats = { updated: new Date().toISOString(), providers: {}, accounts: {}, daily: {} }
}
loadStats()

export function saveStats() {
  stats.updated = new Date().toISOString()
  pruneDaily()
  try {
    atomicWriteJson(STATS_FILE, stats)
    return true
  } catch (error) {
    console.error('[codex-proxy] failed to persist statistics:', error.message)
    return false
  }
}

function ensureProvider(p) {
  if (!stats.providers[p]) stats.providers[p] = { requests: 0, input_tokens: 0, output_tokens: 0, models: {} }
  return stats.providers[p]
}

function ensureModel(p, m) {
  const pr = ensureProvider(p)
  if (!pr.models[m]) pr.models[m] = { requests: 0, input_tokens: 0, output_tokens: 0 }
  return pr.models[m]
}

function ensureDaily(day = statsDayKey()) {
  stats.daily ||= {}
  if (!stats.daily[day]) {
    stats.daily[day] = {
      requests: 0,
      account_attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      providers: {},
      accounts: {}
    }
  }
  const daily = stats.daily[day]
  daily.providers ||= {}
  daily.accounts ||= {}
  return daily
}

function ensureDailyProvider(day, provider) {
  const daily = ensureDaily(day)
  return daily.providers[provider] ||= { requests: 0, input_tokens: 0, output_tokens: 0 }
}

function ensureDailyAccount(day, accountId) {
  const daily = ensureDaily(day)
  return daily.accounts[accountId] ||= {
    requests: 0,
    successes: 0,
    failures: 0,
    rate_limited: 0,
    completed_requests: 0,
    input_tokens: 0,
    output_tokens: 0
  }
}

export function recordUsage(model, provider, inputTokens, outputTokens, accountId = null) {
  if (!model || !provider) return
  const i = Math.max(0, Number(inputTokens) || 0)
  const o = Math.max(0, Number(outputTokens) || 0)
  const pr = ensureProvider(provider)
  const md = ensureModel(provider, model)
  pr.requests++
  pr.input_tokens += i
  pr.output_tokens += o
  md.requests++
  md.input_tokens += i
  md.output_tokens += o

  const day = statsDayKey()
  const daily = ensureDaily(day)
  const dailyProvider = ensureDailyProvider(day, provider)
  daily.requests++
  daily.input_tokens += i
  daily.output_tokens += o
  dailyProvider.requests++
  dailyProvider.input_tokens += i
  dailyProvider.output_tokens += o
  if (accountId) {
    const dailyAccount = ensureDailyAccount(day, accountId)
    dailyAccount.completed_requests++
    dailyAccount.input_tokens += i
    dailyAccount.output_tokens += o
  }
}

export function recordAccountOutcome(accountId, {
  status = 0,
  latencyMs = 0,
  errorType = null,
  errorMessage = null
} = {}) {
  if (!accountId) return
  stats.accounts ||= {}
  const account = stats.accounts[accountId] ||= {
    requests: 0,
    successes: 0,
    failures: 0,
    rate_limited: 0,
    network_errors: 0,
    total_latency_ms: 0,
    average_latency_ms: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    latency_samples_ms: [],
    last_status: null,
    last_error_type: null,
    last_request_at: null
  }
  const code = Math.max(0, Number(status) || 0)
  account.requests += 1
  if (code >= 200 && code < 400) account.successes += 1
  else account.failures += 1
  if (code === 429) account.rate_limited += 1
  if (errorType === 'network') account.network_errors += 1
  account.total_latency_ms += Math.max(0, Number(latencyMs) || 0)
  account.average_latency_ms = Math.round(account.total_latency_ms / account.requests)
  account.latency_samples_ms ||= []
  account.latency_samples_ms.push(Math.max(0, Number(latencyMs) || 0))
  if (account.latency_samples_ms.length > 100) account.latency_samples_ms.shift()
  const sortedLatencies = [...account.latency_samples_ms].sort((a, b) => a - b)
  const percentile = percentileValue => {
    if (!sortedLatencies.length) return 0
    const index = Math.min(sortedLatencies.length - 1, Math.ceil(percentileValue * sortedLatencies.length) - 1)
    return Math.round(sortedLatencies[Math.max(0, index)])
  }
  account.p50_latency_ms = percentile(0.5)
  account.p95_latency_ms = percentile(0.95)
  account.success_rate = account.requests
    ? Number(((account.successes / account.requests) * 100).toFixed(1))
    : 0
  account.last_status = code || null
  account.last_error_type = errorType || null
  account.last_error_message = errorMessage ? String(errorMessage).slice(0, 300) : null
  account.last_request_at = new Date().toISOString()
  account.recent_events ||= []
  account.recent_events.push({
    at: account.last_request_at,
    status: code || null,
    latency_ms: Math.max(0, Number(latencyMs) || 0),
    error_type: errorType || null,
    error_message: errorMessage ? String(errorMessage).slice(0, 300) : null
  })
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  account.recent_events = account.recent_events
    .filter(event => new Date(event.at).getTime() >= cutoff)
    .slice(-10000)

  const day = statsDayKey(account.last_request_at)
  const daily = ensureDaily(day)
  const dailyAccount = ensureDailyAccount(day, accountId)
  daily.account_attempts++
  dailyAccount.requests++
  if (code >= 200 && code < 400) dailyAccount.successes++
  else dailyAccount.failures++
  if (code === 429) dailyAccount.rate_limited++
}

function recentWindow(events, durationMs, now) {
  const cutoff = now - durationMs
  const selected = (events || []).filter(event => new Date(event.at).getTime() >= cutoff)
  const successes = selected.filter(event => Number(event.status) >= 200 && Number(event.status) < 400).length
  const rateLimited = selected.filter(event => Number(event.status) === 429).length
  const latencies = selected.map(event => Number(event.latency_ms) || 0).sort((a, b) => a - b)
  const percentile = value => {
    if (!latencies.length) return 0
    return Math.round(latencies[Math.max(0, Math.ceil(value * latencies.length) - 1)])
  }
  return {
    requests: selected.length,
    successes,
    failures: selected.length - successes,
    rate_limited: rateLimited,
    success_rate: selected.length ? Number((successes / selected.length * 100).toFixed(1)) : null,
    p50_latency_ms: percentile(0.5),
    p95_latency_ms: percentile(0.95)
  }
}

export function getStats() {
  const snapshot = structuredClone(stats)
  const now = Date.now()
  for (const account of Object.values(snapshot.accounts || {})) {
    account.windows = {
      '1h': recentWindow(account.recent_events, 60 * 60 * 1000, now),
      '24h': recentWindow(account.recent_events, 24 * 60 * 60 * 1000, now),
      '7d': recentWindow(account.recent_events, 7 * 24 * 60 * 60 * 1000, now)
    }
    delete account.recent_events
  }
  return snapshot
}

export function resetStats() {
  stats = { updated: new Date().toISOString(), providers: {}, accounts: {}, daily: {} }
  saveStats()
  return stats
}

// Auto-save every 30 seconds
// Auto-save every 30 seconds (skip in test mode)
if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  setInterval(saveStats, 30000).unref()
}
