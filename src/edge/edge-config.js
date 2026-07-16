import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EDGE_DEVELOPMENT_HOST = '127.0.0.1'
export const EDGE_DEVELOPMENT_PORT = 47921
export const GATEWAY_DEVELOPMENT_ORIGIN = 'http://127.0.0.1:47920'
export const EDGE_ALLOWED_STATES = Object.freeze([
  'ready',
  'login_required',
  'account_unavailable',
  'service_unavailable',
  'password_change_required'
])

function parsePort(value, fallback) {
  const port = value ? Number(value) : fallback
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 47892) {
    throw new Error(`Invalid isolated Edge port: ${value}`)
  }
  if (port !== EDGE_DEVELOPMENT_PORT) {
    throw new Error(`Development Edge must use port ${EDGE_DEVELOPMENT_PORT}`)
  }
  return port
}

function isolatedDataRoot(value, repositoryRoot, environment) {
  const result = path.resolve(value)
  const developmentParent = path.resolve(repositoryRoot, '.ai-editor-dev')
  const developmentPrefix = `${developmentParent}${path.sep}`
  const blocked = new Set([
    path.resolve(repositoryRoot),
    path.resolve(repositoryRoot, 'src'),
    path.resolve(repositoryRoot, 'gateway')
  ])
  if (blocked.has(result) || result === path.parse(result).root) {
    throw new Error(`Edge data root is not isolated: ${result}`)
  }
  if (environment !== 'production' && !result.startsWith(developmentPrefix)) {
    throw new Error(`Development Edge data root must be under ${developmentParent}`)
  }
  return result
}

export function loadEdgeConfig(env = process.env, options = {}) {
  const environment = env.NODE_ENV === 'production' ? 'production' : 'development'
  const authMode = env.AI_EDITOR_EDGE_AUTH_MODE === 'mock' ? 'mock' : 'real'
  if (environment === 'production' && authMode === 'mock') {
    throw new Error('Mock authentication is forbidden in production Edge mode')
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(currentDir, '..', '..'))
  const host = env.AI_EDITOR_EDGE_HOST || EDGE_DEVELOPMENT_HOST
  if (host !== EDGE_DEVELOPMENT_HOST) throw new Error('Development Edge must bind to 127.0.0.1')
  const gatewayOrigin = new URL(env.AI_EDITOR_GATEWAY_ORIGIN || GATEWAY_DEVELOPMENT_ORIGIN)
  if (
    (environment !== 'production' && gatewayOrigin.origin !== GATEWAY_DEVELOPMENT_ORIGIN) ||
    (environment === 'production' && gatewayOrigin.protocol !== 'https:') ||
    gatewayOrigin.pathname !== '/' ||
    gatewayOrigin.search ||
    gatewayOrigin.hash ||
    gatewayOrigin.username ||
    gatewayOrigin.password
  ) {
    throw new Error(environment === 'production'
      ? 'Production Gateway origin must use HTTPS without path, query or credentials'
      : `Development Gateway origin must be ${GATEWAY_DEVELOPMENT_ORIGIN}`)
  }
  const state = env.AI_EDITOR_MOCK_STATE || 'ready'
  if (!EDGE_ALLOWED_STATES.includes(state)) throw new Error(`Unsupported mock state: ${state}`)
  const localNonce = env.AI_EDITOR_EDGE_LOCAL_NONCE
  if (typeof localNonce !== 'string' || Buffer.byteLength(localNonce, 'utf8') < 32) {
    throw new Error('AI_EDITOR_EDGE_LOCAL_NONCE must contain at least 32 bytes')
  }
  return Object.freeze({
    host,
    port: parsePort(env.AI_EDITOR_EDGE_PORT, EDGE_DEVELOPMENT_PORT),
    gatewayOrigin: gatewayOrigin.origin,
    dataRoot: isolatedDataRoot(
      env.AI_EDITOR_EDGE_DATA_ROOT || path.join(repositoryRoot, '.ai-editor-dev', 'edge'),
      repositoryRoot,
      environment
    ),
    localNonce,
    authMode,
    environment,
    mockState: state
  })
}
