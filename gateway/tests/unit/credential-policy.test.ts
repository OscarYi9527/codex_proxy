import type { GatewayConfig } from '../../src/config.js'
import {
  assertCredentialStorageAllowed,
  requireDevelopmentPlaintext
} from '../../src/providers/credential-policy.js'

function config(
  environment: GatewayConfig['environment'],
  host = '127.0.0.1'
): GatewayConfig {
  return {
    environment,
    host,
    port: 47920,
    publicOrigin: environment === 'preview' ||
      environment === 'preproduction' ||
      environment === 'production'
      ? 'https://gateway.example.test'
      : 'http://127.0.0.1:47920',
    dataRoot: '.ai-editor-dev/provider-policy-test',
    database: { dialect: 'sqlite', sqliteFile: ':memory:' },
    authMode: 'real',
    mockState: 'ready'
  }
}

describe('plaintext-v1 Provider credential policy (T089)', () => {
  it('allows loopback development with a warning boundary', () => {
    expect(() => assertCredentialStorageAllowed(config('development'), 1)).not.toThrow()
    expect(() => requireDevelopmentPlaintext(config('development'))).not.toThrow()
  })

  it('fails startup and writes outside isolated loopback development', () => {
    expect(() => assertCredentialStorageAllowed(config('production'), 1))
      .toThrow(/Preview\/preproduction\/production Gateway refuses startup/)
    expect(() => assertCredentialStorageAllowed(config('preproduction'), 1))
      .toThrow(/Preview\/preproduction\/production Gateway refuses startup/)
    expect(() => assertCredentialStorageAllowed(config('preview'), 1))
      .toThrow(/Preview\/preproduction\/production Gateway refuses startup/)
    expect(() => assertCredentialStorageAllowed(config('development', '0.0.0.0'), 1))
      .toThrow(/Non-loopback Gateway refuses startup/)
    expect(() => requireDevelopmentPlaintext(config('production')))
      .toThrow(/不允许创建明文/)
    expect(() => requireDevelopmentPlaintext(config('preview')))
      .toThrow(/不允许创建明文/)
    expect(() => assertCredentialStorageAllowed(config('production'), 0)).not.toThrow()
  })
})
