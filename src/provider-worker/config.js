import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROVIDER_WORKER_DEVELOPMENT_HOST = '127.0.0.1'
export const PROVIDER_WORKER_DEVELOPMENT_PORT = 47930

function parseEnvironment(value) {
  const environment = value || 'development'
  if (!['development', 'test', 'production'].includes(environment)) {
    throw new Error(`Unsupported Provider Worker environment: ${environment}`)
  }
  return environment
}

function parseExecutorMode(value) {
  const mode = value || 'mock'
  if (!['mock', 'chatgpt-sub'].includes(mode)) {
    throw new Error(`Unsupported Provider Worker executor: ${mode}`)
  }
  return mode
}

function parsePort(value, environment) {
  const port = value ? Number(value) : PROVIDER_WORKER_DEVELOPMENT_PORT
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 47892) {
    throw new Error(`Invalid Provider Worker port: ${value}`)
  }
  if (environment !== 'production' && port !== PROVIDER_WORKER_DEVELOPMENT_PORT) {
    throw new Error(
      `Development Provider Worker must use port ${PROVIDER_WORKER_DEVELOPMENT_PORT}`
    )
  }
  return port
}

function parseHost(value, environment) {
  const host = value || PROVIDER_WORKER_DEVELOPMENT_HOST
  if (environment !== 'production' && host !== PROVIDER_WORKER_DEVELOPMENT_HOST) {
    throw new Error('Development Provider Worker must bind to 127.0.0.1')
  }
  return host
}

function ensureIsolatedDataRoot(value, repositoryRoot, environment) {
  const resolved = path.resolve(value)
  const developmentParent = path.resolve(repositoryRoot, '.ai-editor-dev')
  const developmentPrefix = `${developmentParent}${path.sep}`
  const forbidden = [
    path.resolve(repositoryRoot),
    path.resolve(repositoryRoot, 'src'),
    path.resolve(repositoryRoot, 'gateway'),
    path.resolve(repositoryRoot, 'codex-proxy-config.json')
  ]
  if (forbidden.includes(resolved) || resolved === path.parse(resolved).root) {
    throw new Error(`Provider Worker data root is not isolated: ${resolved}`)
  }
  if (environment !== 'production' && !resolved.startsWith(developmentPrefix)) {
    throw new Error(
      `Development Provider Worker data root must be under ${developmentParent}`
    )
  }
  return resolved
}

function parsePositiveInteger(value, fallback, name, minimum, maximum) {
  const parsed = value ? Number(value) : fallback
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function parseWorkerIdentity(value, fallback, name) {
  const result = String(value || fallback)
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(result)) {
    throw new Error(`Provider Worker ${name} is invalid`)
  }
  return result
}

function readTlsConfig(env, environment) {
  const paths = {
    key: env.AI_EDITOR_PROVIDER_WORKER_TLS_KEY,
    cert: env.AI_EDITOR_PROVIDER_WORKER_TLS_CERT,
    ca: env.AI_EDITOR_PROVIDER_WORKER_TLS_CA
  }
  const supplied = Object.values(paths).filter(Boolean).length
  if (supplied !== 0 && supplied !== 3) {
    throw new Error('Provider Worker TLS key, certificate, and CA must be configured together')
  }
  if (environment === 'production' && supplied !== 3) {
    throw new Error('Production Provider Worker requires mTLS key, certificate, and CA')
  }
  if (supplied === 0) return null
  for (const [name, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) {
      throw new Error(`Provider Worker TLS ${name} file does not exist: ${file}`)
    }
  }
  return {
    keyFile: path.resolve(paths.key),
    certFile: path.resolve(paths.cert),
    caFile: path.resolve(paths.ca)
  }
}

export function loadProviderWorkerConfig(
  env = process.env,
  options = {}
) {
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
  )
  const repositoryRoot = path.resolve(options.repositoryRoot || sourceRoot)
  const environment = parseEnvironment(env.NODE_ENV)
  const signingSecret = String(env.AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET || '')
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
    throw new Error('Provider Worker signing secret must contain at least 32 bytes')
  }
  const allowedGatewayIds = String(
    env.AI_EDITOR_PROVIDER_WORKER_GATEWAY_IDS || 'gateway-local'
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (!allowedGatewayIds.length || allowedGatewayIds.some(
    value => !/^[A-Za-z0-9._:-]{1,80}$/.test(value)
  )) {
    throw new Error('Provider Worker gateway IDs are invalid')
  }
  const dataRoot = ensureIsolatedDataRoot(
    env.AI_EDITOR_PROVIDER_WORKER_DATA_ROOT ||
      path.join(repositoryRoot, '.ai-editor-dev', 'provider-worker'),
    repositoryRoot,
    environment
  )
  const workerId = parseWorkerIdentity(
    env.AI_EDITOR_PROVIDER_WORKER_ID,
    'worker-local',
    'ID'
  )
  const region = parseWorkerIdentity(
    env.AI_EDITOR_PROVIDER_WORKER_REGION,
    'local-development',
    'region'
  )
  return {
    environment,
    executorMode: parseExecutorMode(
      env.AI_EDITOR_PROVIDER_WORKER_EXECUTOR
    ),
    host: parseHost(env.AI_EDITOR_PROVIDER_WORKER_HOST, environment),
    port: parsePort(env.AI_EDITOR_PROVIDER_WORKER_PORT, environment),
    dataRoot,
    workerId,
    region,
    signingSecret,
    allowedGatewayIds: new Set(allowedGatewayIds),
    maxClockSkewMs: parsePositiveInteger(
      env.AI_EDITOR_PROVIDER_WORKER_MAX_CLOCK_SKEW_MS,
      60_000,
      'Provider Worker clock skew',
      1_000,
      5 * 60_000
    ),
    nonceTtlMs: parsePositiveInteger(
      env.AI_EDITOR_PROVIDER_WORKER_NONCE_TTL_MS,
      2 * 60_000,
      'Provider Worker nonce TTL',
      10_000,
      10 * 60_000
    ),
    turnTtlMs: parsePositiveInteger(
      env.AI_EDITOR_PROVIDER_WORKER_TURN_TTL_MS,
      15 * 60_000,
      'Provider Worker Turn TTL',
      60_000,
      24 * 60 * 60_000
    ),
    tls: readTlsConfig(env, environment)
  }
}
