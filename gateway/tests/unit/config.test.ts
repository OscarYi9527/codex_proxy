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
  })
})
