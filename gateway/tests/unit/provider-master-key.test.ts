import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GatewayConfig } from '../../src/config.js'
import {
  activatePlatformProviderCredentialKeyring,
  loadProviderCredentialKeyring,
  rotatePlatformProviderCredentialKeyring,
  StaticProviderCredentialKeyring
} from '../../src/security/provider-master-key.js'

function config(
  environment: GatewayConfig['environment'],
  dataRoot = '.ai-editor-dev/provider-keyring-test'
): GatewayConfig {
  return {
    environment,
    host: '127.0.0.1',
    port: 47920,
    publicOrigin: environment === 'production'
      ? 'https://gateway.example.test'
      : 'http://127.0.0.1:47920',
    dataRoot,
    database: { dialect: 'sqlite', sqliteFile: ':memory:' },
    authMode: 'real',
    mockState: 'ready'
  }
}

describe('Provider credential master-key adapters', () => {
  it('uses a deterministic, explicitly test-only keyring across test restarts', () => {
    const first = loadProviderCredentialKeyring(config('test'), {})
    const second = loadProviderCredentialKeyring(config('test'), {})
    expect(first.activeKeyId).toBe('provider-test-key-v1')
    expect(first.protection).toBe('deterministic-test-only')
    expect(Buffer.from(first.getKey(first.activeKeyId) as Uint8Array))
      .toEqual(Buffer.from(second.getKey(second.activeKeyId) as Uint8Array))
  })

  it('loads an injected environment/KMS keyring and honors active-key override', () => {
    const oldKey = Buffer.alloc(32, 1).toString('base64')
    const newKey = Buffer.alloc(32, 2).toString('base64')
    const keyring = loadProviderCredentialKeyring(config('production'), {
      AI_EDITOR_GATEWAY_PROVIDER_KEYRING: JSON.stringify({
        version: 1,
        active_key_id: 'old-key',
        keys: {
          'old-key': oldKey,
          'new-key': newKey
        }
      }),
      AI_EDITOR_GATEWAY_PROVIDER_ACTIVE_KEY_ID: 'new-key'
    })
    expect(keyring.activeKeyId).toBe('new-key')
    expect(keyring.keyIds()).toEqual(['old-key', 'new-key'])
    expect(keyring.protection).toBe('environment-or-kms-adapter')
  })

  it('requires an injected KMS keyring in production and rejects malformed keys', () => {
    expect(() => loadProviderCredentialKeyring(config('production'), {}))
      .toThrow(/AI_EDITOR_GATEWAY_PROVIDER_KEYRING is required/)
    expect(() => loadProviderCredentialKeyring(config('production'), {
      AI_EDITOR_GATEWAY_PROVIDER_KEYRING: JSON.stringify({
        version: 1,
        active_key_id: 'short-key',
        keys: { 'short-key': Buffer.alloc(31).toString('base64') }
      })
    })).toThrow(/exactly 32 bytes/)
    expect(() => loadProviderCredentialKeyring(config('production'), {
      AI_EDITOR_GATEWAY_PROVIDER_KEYRING: JSON.stringify({
        version: 1,
        active_key_id: 'malformed-key',
        keys: {
          'malformed-key': `${Buffer.alloc(32).toString('base64')}!`
        }
      })
    })).toThrow(/canonical Base64/)
  })

  it('rejects unsafe key IDs, oversized keyrings and external rotation', () => {
    expect(() => new StaticProviderCredentialKeyring(
      'invalid key id',
      new Map([['invalid key id', new Uint8Array(32)]])
    )).toThrow(/active key configuration/)

    const keys = new Map(
      Array.from({ length: 17 }, (_, index) => [
        `key-${index}`,
        new Uint8Array(32).fill(index)
      ] as const)
    )
    expect(() => new StaticProviderCredentialKeyring('key-0', keys))
      .toThrow(/active key configuration/)

    expect(() => rotatePlatformProviderCredentialKeyring(config('development'), {
      AI_EDITOR_GATEWAY_PROVIDER_KEYRING: JSON.stringify({
        version: 1,
        active_key_id: 'external-key',
        keys: {
          'external-key': Buffer.alloc(32, 3).toString('base64')
        }
      })
    })).toThrow(/rotated externally/)
    expect(() => activatePlatformProviderCredentialKeyring(
      config('development'),
      'external-key',
      {
        AI_EDITOR_GATEWAY_PROVIDER_KEYRING: JSON.stringify({
          version: 1,
          active_key_id: 'external-key',
          keys: {
            'external-key': Buffer.alloc(32, 3).toString('base64')
          }
        })
      }
    )).toThrow(/must set AI_EDITOR_GATEWAY_PROVIDER_ACTIVE_KEY_ID externally/)
  })

  it('persists, rotates and rolls back a Windows DPAPI keyring', () => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ai-editor-provider-keyring-')
    )
    type LoadOptions = NonNullable<
      Parameters<typeof loadProviderCredentialKeyring>[2]
    >
    const runner: NonNullable<LoadOptions['runner']> = (
      _command,
      args,
      options
    ) => {
      const input = Buffer.from(String(options.input || ''), 'base64')
      const transformed = Buffer.from(input.map(value => value ^ 0x5a))
      const stdout = transformed.toString('base64')
      expect(args.join(' ')).toMatch(/ProtectedData]::(?:Protect|Unprotect)/)
      return {
        pid: 1,
        output: [null, stdout, ''],
        stdout,
        stderr: '',
        status: 0,
        signal: null
      }
    }
    try {
      const gatewayConfig = config('development', dataRoot)
      const first = loadProviderCredentialKeyring(gatewayConfig, {}, {
        platform: 'win32',
        runner
      })
      const reloaded = loadProviderCredentialKeyring(gatewayConfig, {}, {
        platform: 'win32',
        runner
      })
      expect(reloaded.activeKeyId).toBe(first.activeKeyId)
      expect(Buffer.from(reloaded.getKey(reloaded.activeKeyId) as Uint8Array))
        .toEqual(Buffer.from(first.getKey(first.activeKeyId) as Uint8Array))

      const rotated = rotatePlatformProviderCredentialKeyring(
        gatewayConfig,
        {},
        { platform: 'win32', runner }
      )
      expect(rotated.activeKeyId).not.toBe(first.activeKeyId)
      expect(rotated.keyIds()).toEqual([
        first.activeKeyId,
        rotated.activeKeyId
      ])

      const rolledBack = activatePlatformProviderCredentialKeyring(
        gatewayConfig,
        first.activeKeyId,
        {},
        { platform: 'win32', runner }
      )
      expect(rolledBack.activeKeyId).toBe(first.activeKeyId)
      expect(rolledBack.keyIds()).toContain(rotated.activeKeyId)
      expect(loadProviderCredentialKeyring(gatewayConfig, {}, {
        platform: 'win32',
        runner
      }).activeKeyId).toBe(first.activeKeyId)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  it('passes the macOS Keychain value over stdin and stores only metadata on disk', () => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ai-editor-provider-keychain-')
    )
    type LoadOptions = NonNullable<
      Parameters<typeof loadProviderCredentialKeyring>[2]
    >
    let keychainValue = ''
    const calls: Array<{ args: readonly string[]; input: string }> = []
    const runner: NonNullable<LoadOptions['runner']> = (
      _command,
      args,
      options
    ) => {
      const input = options.input
        ? Buffer.from(options.input).toString('utf8')
        : ''
      calls.push({ args, input })
      if (args[0] === 'find-generic-password') {
        return {
          pid: 1,
          output: [null, `${keychainValue}\n`, ''],
          stdout: `${keychainValue}\n`,
          stderr: '',
          status: keychainValue ? 0 : 1,
          signal: null
        }
      }
      keychainValue = input.trim()
      return {
        pid: 1,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null
      }
    }
    try {
      const gatewayConfig = config('development', dataRoot)
      const first = loadProviderCredentialKeyring(gatewayConfig, {}, {
        platform: 'darwin',
        runner
      })
      expect(first.protection).toBe('macOS Keychain')
      expect(keychainValue).toContain(first.activeKeyId)
      expect(calls[0]?.args.join(' ')).not.toContain(keychainValue)
      const metadata = fs.readFileSync(
        path.join(dataRoot, 'gateway-provider-keys.keychain.gateway-secret'),
        'utf8'
      )
      expect(metadata).not.toContain(first.activeKeyId)
      expect(metadata).not.toContain(
        Buffer.from(first.getKey(first.activeKeyId) as Uint8Array).toString('base64')
      )

      const reloaded = loadProviderCredentialKeyring(gatewayConfig, {}, {
        platform: 'darwin',
        runner
      })
      expect(reloaded.activeKeyId).toBe(first.activeKeyId)
      expect(calls.some(call =>
        call.args[0] === 'find-generic-password' &&
        call.args.includes('-w')
      )).toBe(true)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
