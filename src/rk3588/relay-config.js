import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const RK3588_DEFAULT_HOST = '127.0.0.1'
export const RK3588_DEFAULT_PORT = 47930

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function assertTlsVerificationEnabled(env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return
  throw new Error(
    'TLS certificate verification is disabled by NODE_TLS_REJECT_UNAUTHORIZED=0. ' +
    'Remove this variable; use NODE_EXTRA_CA_CERTS for a trusted private CA.'
  )
}

function secretFile(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`)
  }
  const file = path.resolve(value)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error(`${name} must reference a regular file`)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be readable or writable by group/other users`)
  }
  const raw = fs.readFileSync(file)
  try {
    const result = raw.toString('utf8').trim()
    const length = Buffer.byteLength(result, 'utf8')
    if (length < 32 || length > 4096 || /[\r\n\0]/.test(result)) {
      throw new Error(`${name} must contain one 32-4096 byte credential`)
    }
    return result
  } finally {
    raw.fill(0)
  }
}

function upstreamOrigin(value, allowInsecureLoopback) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('RK3588_UPSTREAM_ORIGIN is required')
  }
  const url = new URL(value)
  const loopbackHttp = allowInsecureLoopback &&
    url.protocol === 'http:' &&
    ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !loopbackHttp) ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'RK3588_UPSTREAM_ORIGIN must be an exact HTTPS origin without path, query, or credentials'
    )
  }
  return url.origin
}

function allowedHosts(value, port) {
  const hosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`
  ])
  for (const item of String(value || '').split(',')) {
    const host = item.trim().toLowerCase()
    if (!host) continue
    if (
      host.length > 253 ||
      /[\s/@\\?#]/.test(host) ||
      host.startsWith('.') ||
      host.endsWith('.')
    ) {
      throw new Error(`RK3588_ALLOWED_HOSTS contains an invalid host: ${item}`)
    }
    try {
      if (new URL(`http://${host}`).host.toLowerCase() !== host) {
        throw new Error('host normalization changed')
      }
    } catch {
      throw new Error(`RK3588_ALLOWED_HOSTS contains an invalid host: ${item}`)
    }
    hosts.add(host)
  }
  return Object.freeze([...hosts])
}

export function digestClientApiKey(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export function loadRk3588RelayConfig(env = process.env, options = {}) {
  assertTlsVerificationEnabled(env)
  const environment = env.NODE_ENV === 'test' ? 'test' : 'production'
  const host = env.RK3588_RELAY_HOST || RK3588_DEFAULT_HOST
  if (host !== RK3588_DEFAULT_HOST) {
    throw new Error(
      'RK3588 relay must bind to 127.0.0.1; publish it with Tailscale Serve or a local TLS proxy'
    )
  }
  const port = integer(
    env.RK3588_RELAY_PORT,
    RK3588_DEFAULT_PORT,
    1024,
    65535,
    'RK3588_RELAY_PORT'
  )
  if ([47892, 47920, 47921].includes(port)) {
    throw new Error(`RK3588_RELAY_PORT conflicts with an existing service: ${port}`)
  }
  const clientApiKey = secretFile(
    env.RK3588_CLIENT_API_KEY_FILE,
    'RK3588_CLIENT_API_KEY_FILE'
  )
  const upstreamApiKey = secretFile(
    env.RK3588_UPSTREAM_API_KEY_FILE,
    'RK3588_UPSTREAM_API_KEY_FILE'
  )
  const config = {
    environment,
    host,
    port,
    allowedHosts: allowedHosts(env.RK3588_ALLOWED_HOSTS, port),
    clientApiKeyDigest: digestClientApiKey(clientApiKey),
    upstreamOrigin: upstreamOrigin(
      env.RK3588_UPSTREAM_ORIGIN,
      options.allowInsecureLoopbackUpstream === true
    ),
    bodyLimitBytes: integer(
      env.RK3588_BODY_LIMIT_MB,
      16,
      1,
      64,
      'RK3588_BODY_LIMIT_MB'
    ) * 1024 * 1024,
    maxInFlight: integer(
      env.RK3588_MAX_IN_FLIGHT,
      8,
      1,
      256,
      'RK3588_MAX_IN_FLIGHT'
    ),
    upstreamTimeoutMs: integer(
      env.RK3588_UPSTREAM_TIMEOUT_MS,
      10 * 60_000,
      1_000,
      30 * 60_000,
      'RK3588_UPSTREAM_TIMEOUT_MS'
    )
  }
  Object.defineProperty(config, 'upstreamApiKey', {
    value: upstreamApiKey,
    enumerable: false,
    configurable: false,
    writable: false
  })
  return Object.freeze(config)
}
