import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GatewayConfig } from '../../src/config.js'
import { loadGatewaySecrets } from '../../src/security/gateway-secrets.js'

function config(dataRoot: string, environment: GatewayConfig['environment']): GatewayConfig {
  return {
    environment,
    host: '127.0.0.1',
    port: 47920,
    dataRoot,
    database: {
      dialect: 'sqlite',
      sqliteFile: path.join(dataRoot, 'gateway.sqlite')
    },
    authMode: 'real',
    mockState: 'ready'
  }
}

describe('Gateway signing and digest secrets', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-gateway-secrets-'))
  })

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it('creates development keys once and reloads the same protected envelope', () => {
    const first = loadGatewaySecrets(config(dataRoot, 'development'), {})
    const second = loadGatewaySecrets(config(dataRoot, 'development'), {})
    expect(first.accessTokenKey).toHaveLength(32)
    expect(first.digestKey).toHaveLength(32)
    expect(second.accessTokenKey).toEqual(first.accessTokenKey)
    expect(second.digestKey).toEqual(first.digestKey)

    const file = path.join(dataRoot, 'gateway-auth-keys.gateway-secret')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).not.toContain(Buffer.from(first.accessTokenKey).toString('hex'))
    expect(JSON.parse(text)).toMatchObject({ version: 1 })
  })

  it('requires independent production keys with at least 32 decoded bytes', () => {
    const value = Buffer.alloc(32, 5).toString('base64')
    const loaded = loadGatewaySecrets(config(dataRoot, 'production'), {
      AI_EDITOR_GATEWAY_ACCESS_TOKEN_KEY: value,
      AI_EDITOR_GATEWAY_DIGEST_KEY: value
    })
    expect(loaded.accessTokenKey).toEqual(new Uint8Array(32).fill(5))
    expect(() => loadGatewaySecrets(config(dataRoot, 'production'), {}))
      .toThrow(/ACCESS_TOKEN_KEY.*required/)
    expect(() => loadGatewaySecrets(config(dataRoot, 'production'), {
      AI_EDITOR_GATEWAY_ACCESS_TOKEN_KEY: Buffer.alloc(8).toString('base64'),
      AI_EDITOR_GATEWAY_DIGEST_KEY: value
    })).toThrow(/at least 32 bytes/)
  })

  it('fails closed for malformed development envelopes', () => {
    const file = path.join(dataRoot, 'gateway-auth-keys.gateway-secret')
    fs.writeFileSync(file, 'null\n')
    expect(() => loadGatewaySecrets(config(dataRoot, 'test'), {}))
      .toThrow(/envelope is invalid/)

    fs.writeFileSync(file, JSON.stringify({ version: 2 }))
    expect(() => loadGatewaySecrets(config(dataRoot, 'test'), {}))
      .toThrow(/version is unsupported/)

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      accessTokenKey: Buffer.alloc(32).toString('base64')
    }))
    expect(() => loadGatewaySecrets(config(dataRoot, 'test'), {}))
      .toThrow(/digestKey is required/)
  })
})
