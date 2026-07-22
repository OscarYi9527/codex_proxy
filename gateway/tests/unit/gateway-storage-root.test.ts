import path from 'node:path'
import { bindGatewayProxyStorageRoot } from '../../src/app.js'
import type { GatewayConfig } from '../../src/config.js'

function config(dataRoot: string): GatewayConfig {
  return {
    environment: 'preview',
    host: '127.0.0.1',
    port: 47920,
    publicOrigin: 'https://gateway.example.com',
    dataRoot,
    database: {
      dialect: 'sqlite',
      sqliteFile: path.join(dataRoot, 'gateway.sqlite'),
      migrateOnStart: true
    },
    authMode: 'real',
    mockState: 'ready',
    requestBody: {
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 60_000
    }
  }
}

describe('Gateway standalone runtime storage boundary', () => {
  it('binds inherited standalone storage to the isolated Gateway data root', () => {
    const env: NodeJS.ProcessEnv = {
      CODEX_PROXY_STORAGE_ROOT: '/opt/ai-editor'
    }
    const dataRoot = path.join('tmp', 'gateway-runtime-data')

    expect(bindGatewayProxyStorageRoot(config(dataRoot), env))
      .toBe(path.resolve(dataRoot))
    expect(env.CODEX_PROXY_STORAGE_ROOT).toBe(path.resolve(dataRoot))
  })
})
