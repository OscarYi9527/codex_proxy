import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GATEWAY_DEVELOPMENT_HOST = '127.0.0.1'
export const GATEWAY_DEVELOPMENT_PORT = 47920
export const EDGE_DEVELOPMENT_PORT = 47921

export interface GatewayConfig {
  readonly environment: 'development' | 'test' | 'production'
  readonly host: string
  readonly port: number
  readonly dataRoot: string
  readonly database: {
    readonly dialect: 'sqlite' | 'postgres'
    readonly sqliteFile: string
    readonly postgresUrl?: string
  }
  readonly authMode: 'real' | 'mock'
  readonly mockState: MockAccountState
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
  return {
    environment,
    host: parseHost(env.AI_EDITOR_GATEWAY_HOST, environment),
    port: parsePort(env.AI_EDITOR_GATEWAY_PORT, GATEWAY_DEVELOPMENT_PORT, environment),
    dataRoot,
    database: {
      dialect,
      sqliteFile: path.join(dataRoot, 'gateway.sqlite'),
      ...(postgresUrl ? { postgresUrl } : {})
    },
    authMode,
    mockState: parseMockState(env.AI_EDITOR_MOCK_STATE)
  }
}
