// Lightweight in-memory provider circuit breaker.
// Account/model quota errors are intentionally excluded: this breaker only
// reacts to provider-level timeouts, network errors and 5xx responses.

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_RESET_TIMEOUT_MS = 30_000
// A half-open probe normally resolves in seconds. If the caller disconnects
// or the probe request otherwise never reports its result back through
// recordCircuitResult, halfOpenProbeActive would stay true forever and wedge
// the circuit open permanently. Treat a probe older than this as abandoned
// and let the next request take over as a fresh probe.
const DEFAULT_PROBE_STALE_MS = 60_000
const circuits = new Map()

function stateFor(name) {
  if (!circuits.has(name)) {
    circuits.set(name, {
      name,
      state: 'closed',
      failures: 0,
      openedAt: null,
      lastFailure: null,
      halfOpenProbeActive: false,
      halfOpenProbeStartedAt: null
    })
  }
  return circuits.get(name)
}

function isProviderFailure(status, error) {
  if (error) return true
  return status === 408 || (status >= 500 && status <= 599)
}

function unavailableError(name, message, retryAfterMs) {
  const error = new Error(`Upstream circuit "${name}" ${message}`)
  error.code = 'CIRCUIT_OPEN'
  error.status = 503
  error.statusCode = 503
  error.retryable = true
  error.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0)
  return error
}

export function assertCircuitAvailable(name, {
  resetTimeoutMs = DEFAULT_RESET_TIMEOUT_MS,
  probeStaleMs = DEFAULT_PROBE_STALE_MS
} = {}) {
  if (!name) return
  const circuit = stateFor(name)
  if (circuit.state === 'half-open') {
    const probeAgeMs = Date.now() - circuit.halfOpenProbeStartedAt
    if (circuit.halfOpenProbeActive && probeAgeMs < probeStaleMs) {
      throw unavailableError(
        name,
        'is probing recovery',
        probeStaleMs - probeAgeMs
      )
    }
    circuit.halfOpenProbeActive = true
    circuit.halfOpenProbeStartedAt = Date.now()
    return { probe: true }
  }
  if (circuit.state !== 'open') return { probe: false }

  if (Date.now() - circuit.openedAt >= resetTimeoutMs && !circuit.halfOpenProbeActive) {
    circuit.state = 'half-open'
    circuit.halfOpenProbeActive = true
    circuit.halfOpenProbeStartedAt = Date.now()
    return { probe: true }
  }

  throw unavailableError(
    name,
    'is open',
    resetTimeoutMs - (Date.now() - circuit.openedAt)
  )
}

export function recordCircuitResult(name, {
  status = 0,
  error = null,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD
} = {}) {
  if (!name) return
  const circuit = stateFor(name)
  if (!isProviderFailure(Number(status) || 0, error)) {
    if (status > 0 && status < 500) {
      circuit.state = 'closed'
      circuit.failures = 0
      circuit.openedAt = null
      circuit.lastFailure = null
      circuit.halfOpenProbeActive = false
      circuit.halfOpenProbeStartedAt = null
    }
    return
  }

  circuit.failures += 1
  circuit.lastFailure = {
    at: new Date().toISOString(),
    status: Number(status) || null,
    message: error?.message || null
  }
  circuit.halfOpenProbeActive = false
  circuit.halfOpenProbeStartedAt = null

  if (circuit.state === 'half-open' || circuit.failures >= failureThreshold) {
    circuit.state = 'open'
    circuit.openedAt = Date.now()
  }
}

export function getCircuitStates() {
  return [...circuits.values()].map(circuit => ({ ...circuit }))
}

export function resetCircuits(name = null) {
  if (name) circuits.delete(name)
  else circuits.clear()
}
