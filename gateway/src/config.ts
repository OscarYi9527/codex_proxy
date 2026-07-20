import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GATEWAY_DEVELOPMENT_HOST = '127.0.0.1'
export const GATEWAY_DEVELOPMENT_PORT = 47920
export const EDGE_DEVELOPMENT_PORT = 47921
export const PROVIDER_WORKER_DEVELOPMENT_PORT = 47930

export interface ProviderWorkerGatewayConfig {
  readonly origin: string
  readonly gatewayId: string
  readonly workerId: string
  readonly region: string
  readonly signingSecret: string
  readonly tls: {
    readonly keyFile: string
    readonly certFile: string
    readonly caFile: string
  } | null
}

export interface GatewayConfig {
  readonly environment: 'development' | 'test' | 'production'
  readonly host: string
  readonly port: number
  readonly publicOrigin?: string
  readonly dataRoot: string
  readonly database: {
    readonly dialect: 'sqlite' | 'postgres'
    readonly sqliteFile: string
    readonly postgresUrl?: string
  }
  readonly authMode: 'real' | 'mock'
  readonly mockState: MockAccountState
  readonly providerWorker?: ProviderWorkerGatewayConfig
}

export type MockAccountState =
  | 'ready'
  | 'login_required'
  | 'account_unavailable'
  | 'service_unavailable'
  | 'password_change_required'

const allowedMockStates = new Set<MockAccountState>([
  'ready',
  'login_required',
  'account_unavailable',
  'service_unavailable',
  'password_change_required'
])

function parsePort(
  value: string | undefined,
  fallback: number,
  environment: GatewayConfig['environment']
): number {
  const port = value ? Number(value) : fallback
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 47892) {
    throw new Error(`Invalid isolated development port: ${value}`)
  }
  if (environment !== 'production' && port !== GATEWAY_DEVELOPMENT_PORT) {
    throw new Error(`Development Gateway must use port ${GATEWAY_DEVELOPMENT_PORT}`)
  }
  return port
}

function parseHost(value: string | undefined, environment: GatewayConfig['environment']): string {
  const host = value || GATEWAY_DEVELOPMENT_HOST
  if (environment !== 'production' && host !== '127.0.0.1') {
    throw new Error('Development Gateway must bind to 127.0.0.1')
  }
  return host
}

function parseMockState(value: string | undefined): MockAccountState {
  const state = (value || 'ready') as MockAccountState
  if (!allowedMockStates.has(state)) throw new Error(`Unsupported mock account state: ${value}`)
  return state
}

function parseProviderWorker(
  env: NodeJS.ProcessEnv,
  environment: GatewayConfig['environment']
): ProviderWorkerGatewayConfig | undefined {
  const candidate = env.AI_EDITOR_PROVIDER_WORKER_ORIGIN
  if (!candidate) return undefined
  const url = new URL(candidate)
  if (
    url.origin !== candidate ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (environment === 'production' && url.protocol !== 'https:') ||
    (
      environment !== 'production' &&
      url.origin !== `http://127.0.0.1:${PROVIDER_WORKER_DEVELOPMENT_PORT}`
    )
  ) {
    throw new Error(environment === 'production'
      ? 'Production Provider Worker origin must be an HTTPS origin'
      : `Development Provider Worker origin must be http://127.0.0.1:${PROVIDER_WORKER_DEVELOPMENT_PORT}`)
  }
  const signingSecret = String(env.AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET || '')
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
    throw new Error('Provider Worker signing secret must contain at least 32 bytes')
  }
  const gatewayId = String(env.AI_EDITOR_PROVIDER_WORKER_GATEWAY_ID || 'gateway-local')
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(gatewayId)) {
    throw new Error('Provider Worker Gateway ID is invalid')
  }
  const workerId = String(env.AI_EDITOR_PROVIDER_WORKER_ID || 'worker-local')
  const region = String(
    env.AI_EDITOR_PROVIDER_WORKER_REGION || 'local-development'
  )
  if (
    !/^[A-Za-z0-9._:-]{1,80}$/.test(workerId) ||
    !/^[A-Za-z0-9._:-]{1,80}$/.test(region)
  ) {
    throw new Error('Provider Worker identity is invalid')
  }
  const tlsValues = [
    env.AI_EDITOR_PROVIDER_WORKER_CLIENT_TLS_KEY,
    env.AI_EDITOR_PROVIDER_WORKER_CLIENT_TLS_CERT,
    env.AI_EDITOR_PROVIDER_WORKER_CLIENT_TLS_CA
  ]
  const supplied = tlsValues.filter(Boolean).length
  if (supplied !== 0 && supplied !== 3) {
    throw new Error('Provider Worker client TLS key, certificate, and CA must be configured together')
  }
  if (environment === 'production' && supplied !== 3) {
    throw new Error('Production Gateway requires Provider Worker mTLS client credentials')
  }
  const tls = supplied === 3
    ? {
        keyFile: path.resolve(tlsValues[0]!),
        certFile: path.resolve(tlsValues[1]!),
        caFile: path.resolve(tlsValues[2]!)
      }
    : null
  if (tls) {
    for (const file of [tls.keyFile, tls.certFile, tls.caFile]) {
      if (!fs.existsSync(file)) {
        throw new Error(`Provider Worker client TLS file does not exist: ${file}`)
      }
    }
  }
  return {
    origin: url.origin,
    gatewayId,
    workerId,
    region,
    signingSecret,
    tls
  }
}

function ensureIsolatedDataRoot(
  value: string,
  repositoryRoot: string,
  environment: GatewayConfig['environment']
): string {
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
    throw new Error(`Gateway data root is not isolated: ${resolved}`)
  }
  if (
    environment !== 'production' &&
    !resolved.startsWith(developmentPrefix)
  ) {
    throw new Error(`Development Gateway data root must be under ${developmentParent}`)
  }
  return resolved
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { repositoryRoot?: string } = {}
): GatewayConfig {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const repositoryRoot = path.resolve(options.repositoryRoot || sourceRoot)
  const environment = (env.NODE_ENV || 'development') as GatewayConfig['environment']
  if (!['development', 'test', 'production'].includes(environment)) {
    throw new Error(`Unsupported Gateway environment: ${environment}`)
  }
  const dataRoot = ensureIsolatedDataRoot(
    env.AI_EDITOR_GATEWAY_DATA_ROOT || path.join(repositoryRoot, '.ai-editor-dev', 'gateway'),
    repositoryRoot,
    environment
  )
  const dialect = env.AI_EDITOR_GATEWAY_DB_DIALECT === 'postgres' ? 'postgres' : 'sqlite'
  const postgresUrl = env.AI_EDITOR_GATEWAY_POSTGRES_URL
  if (dialect === 'postgres' && !postgresUrl) {
    throw new Error('AI_EDITOR_GATEWAY_POSTGRES_URL is required for the postgres dialect')
  }
  const authMode = env.AI_EDITOR_GATEWAY_AUTH_MODE === 'mock' ? 'mock' : 'real'
  if (environment === 'production' && authMode === 'mock') {
    throw new Error('Mock authentication is forbidden in production Gateway mode')
  }
  const host = parseHost(env.AI_EDITOR_GATEWAY_HOST, environment)
  const port = parsePort(env.AI_EDITOR_GATEWAY_PORT, GATEWAY_DEVELOPMENT_PORT, environment)
  const candidateOrigin = env.AI_EDITOR_GATEWAY_PUBLIC_ORIGIN ||
    `http://${host}:${port}`
  const publicUrl = new URL(candidateOrigin)
  if (
    publicUrl.origin !== candidateOrigin ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password ||
    (environment === 'production' && publicUrl.protocol !== 'https:') ||
    (environment !== 'production' && publicUrl.origin !== `http://${host}:${port}`)
  ) {
    throw new Error(environment === 'production'
      ? 'Production Gateway public origin must be an HTTPS origin'
      : 'Development Gateway public origin must match its fixed listener')
  }
  const providerWorker = parseProviderWorker(env, environment)
  return {
    environment,
    host,
    port,
    publicOrigin: publicUrl.origin,
    dataRoot,
    database: {
      dialect,
      sqliteFile: path.join(dataRoot, 'gateway.sqlite'),
      ...(postgresUrl ? { postgresUrl } : {})
    },
    authMode,
    mockState: parseMockState(env.AI_EDITOR_MOCK_STATE),
    ...(providerWorker ? { providerWorker } : {})
  }
}
