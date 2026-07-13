import fs from 'fs'
import path from 'path'

const MAX_EVENTS_PER_PROVIDER = 100
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
  health.last_error = error ? String(error?.message || error).slice(0, 300) : null
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
  health.recent_events = health.recent_events.slice(-MAX_EVENTS_PER_PROVIDER)
  state.updated_at = now
  scheduleSave()
  return structuredClone(health)
}

export function getProviderHealth() {
  return structuredClone(state)
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
    console.error('[codex-proxy] failed to persist provider health:', error.message)
    return false
  }
}
