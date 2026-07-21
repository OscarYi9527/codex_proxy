import fs from 'fs'
import path from 'path'
import { safeErrorText } from './logger.js'

const MAX_EVENTS_PER_PROVIDER = 10000
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
let healthFile = null
let saveTimer = null
let state = { updated_at: null, providers: {} }

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, file)
}

export function initializeProviderHealth(baseDir) {
  healthFile = path.join(baseDir, 'codex-proxy-provider-health.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(healthFile, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state = { updated_at: parsed.updated_at || null, providers: parsed.providers || {} }
    }
  } catch {}
  return getProviderHealth()
}

function classify(status, error) {
  const code = Number(status) || 0
  if (error || code === 408 || code >= 500) return 'unhealthy'
  if (code === 401 || code === 403) return 'auth_error'
  if (code === 402 || code === 429) return 'degraded'
  return code > 0 ? 'healthy' : 'unknown'
}

function scheduleSave() {
  if (!healthFile || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveProviderHealth()
  }, 250)
  saveTimer.unref?.()
}

export function recordProviderOutcome(provider, {
  status = 0,
  latencyMs = 0,
  error = null,
  source = 'request'
} = {}) {
  if (!provider) return null
  const now = new Date().toISOString()
  const health = state.providers[provider] ||= {
    state: 'unknown',
    consecutive_failures: 0,
    last_checked_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_status: null,
    last_latency_ms: null,
    last_error: null,
    source: null,
    recent_events: []
  }
  const healthState = classify(status, error)
  health.state = healthState
  health.last_checked_at = now
  health.last_status = Number(status) || null
  health.last_latency_ms = Math.max(0, Number(latencyMs) || 0)
  health.last_error = error ? safeErrorText(error, 300) : null
  health.source = source
  if (healthState === 'healthy') {
    health.last_success_at = now
    health.consecutive_failures = 0
  } else if (healthState === 'unhealthy') {
    health.last_failure_at = now
    health.consecutive_failures += 1
  }
  health.recent_events ||= []
  health.recent_events.push({
    at: now,
    state: healthState,
    status: health.last_status,
    latency_ms: health.last_latency_ms,
    error: health.last_error,
    source
  })
  const cutoff = Date.now() - EVENT_RETENTION_MS
  health.recent_events = health.recent_events
    .filter(event => Date.parse(event.at) >= cutoff)
    .slice(-MAX_EVENTS_PER_PROVIDER)
  state.updated_at = now
  scheduleSave()
  return structuredClone(health)
}

function trendWindow(events, durationMs, now) {
  const selected = (events || []).filter(event => now - Date.parse(event.at) <= durationMs)
  const successes = selected.filter(event => event.state === 'healthy').length
  const rateLimited = selected.filter(event => Number(event.status) === 429).length
  const latencies = selected.map(event => Number(event.latency_ms) || 0).sort((a, b) => a - b)
  const percentile = value => latencies.length
    ? Math.round(latencies[Math.max(0, Math.ceil(value * latencies.length) - 1)])
    : 0
  return {
    requests: selected.length,
    successes,
    failures: selected.length - successes,
    rate_limited: rateLimited,
    success_rate: selected.length ? Number((successes / selected.length * 100).toFixed(1)) : null,
    p95_latency_ms: percentile(0.95)
  }
}

export function getProviderHealth() {
  const snapshot = structuredClone(state)
  const now = Date.now()
  for (const provider of Object.values(snapshot.providers || {})) {
    provider.windows = {
      '1h': trendWindow(provider.recent_events, 60 * 60 * 1000, now),
      '24h': trendWindow(provider.recent_events, 24 * 60 * 60 * 1000, now),
      '7d': trendWindow(provider.recent_events, 7 * 24 * 60 * 60 * 1000, now)
    }
    const hour = provider.windows['1h']
    const day = provider.windows['24h']
    provider.trend_warning = hour.requests >= 3 && (
      Number(hour.success_rate) < 70 ||
      hour.rate_limited >= 3 ||
      (day.p95_latency_ms > 0 && hour.p95_latency_ms > day.p95_latency_ms * 1.8)
    ) ? {
      level: Number(hour.success_rate) < 50 ? 'critical' : 'warning',
      message: Number(hour.success_rate) < 70
        ? `1h success rate dropped to ${hour.success_rate}%`
        : (hour.rate_limited >= 3 ? `${hour.rate_limited} rate limits in 1h` : '1h P95 latency increased')
    } : null
    delete provider.recent_events
  }
  return snapshot
}

export function resetProviderHealth() {
  state = { updated_at: new Date().toISOString(), providers: {} }
  saveProviderHealth()
  return getProviderHealth()
}

export function saveProviderHealth() {
  if (!healthFile) return false
  try {
    atomicWrite(healthFile, state)
    return true
  } catch (error) {
    console.error('[codex-proxy] failed to persist provider health:', safeErrorText(error))
    return false
  }
}
