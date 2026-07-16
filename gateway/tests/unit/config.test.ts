import path from 'node:path'
import { loadGatewayConfig } from '../../src/config.js'

describe('Gateway fixed development configuration', () => {
  const repositoryRoot = path.resolve('F:/isolated-repository')

  it('uses fixed loopback ports and isolated data roots by default', () => {
    const config = loadGatewayConfig({ NODE_ENV: 'test' }, { repositoryRoot })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(47920)
    expect(config.dataRoot).toBe(path.join(repositoryRoot, '.ai-editor-dev', 'gateway'))
    expect(config.database.sqliteFile).toBe(path.join(config.dataRoot, 'gateway.sqlite'))
    expect(config.authMode).toBe('real')
  })

  it('rejects shared port, public development host, and repository data root', () => {
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_PORT: '47892'
    }, { repositoryRoot })).toThrow(/47892|Invalid isolated/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_PORT: '47922'
    }, { repositoryRoot })).toThrow(/47920/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_HOST: '0.0.0.0'
    }, { repositoryRoot })).toThrow(/127\.0\.0\.1/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_DATA_ROOT: repositoryRoot
    }, { repositoryRoot })).toThrow(/not isolated/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_DATA_ROOT: path.resolve('F:/shared-runtime')
    }, { repositoryRoot })).toThrow(/must be under/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'unsupported'
    }, { repositoryRoot })).toThrow(/Unsupported Gateway environment/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_MOCK_STATE: 'unknown'
    }, { repositoryRoot })).toThrow(/Unsupported mock account state/)
  })

  it('supports explicit production PostgreSQL configuration', () => {
    const dataRoot = path.resolve('F:/production-gateway-data')
    const production = loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_HOST: '10.0.0.5',
      AI_EDITOR_GATEWAY_PORT: '8443',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway',
      AI_EDITOR_MOCK_STATE: 'login_required'
    }, { repositoryRoot })
    expect(production).toMatchObject({
      environment: 'production',
      host: '10.0.0.5',
      port: 8443,
      dataRoot,
      authMode: 'real',
      mockState: 'login_required',
      database: {
        dialect: 'postgres',
        postgresUrl: 'postgres://gateway@example.test/gateway'
      }
    })
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres'
    }, { repositoryRoot })).toThrow(/POSTGRES_URL/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_AUTH_MODE: 'mock'
    }, { repositoryRoot })).toThrow(/Mock authentication is forbidden/)
  })
})
