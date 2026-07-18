import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  LocalAccountBindingStore,
  MacKeychainRefreshTokenStore,
  MemoryRefreshTokenStore,
  WindowsDpapiRefreshTokenStore
} from '../src/edge/local-account-store.js'
import { LocalHandoffService } from '../src/edge/local-handoff.js'
import { GatewayClient } from '../src/edge/gateway-client.js'

const roots = []

function testRoot(name) {
  const root = path.resolve('.ai-editor-dev', `edge-secure-${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Edge real handoff and secure storage (T026/T032/T033)', () => {
  it('stores Refresh Token through DPAPI while Access Token remains memory-only', async () => {
    const root = testRoot('dpapi')
    let protectedPlaintext = null
    const runner = (_file, _args, options) => {
      const input = Buffer.from(options.input, 'base64').toString('utf8')
      if (protectedPlaintext === null) {
        protectedPlaintext = input
        return {
          status: 0,
          stdout: Buffer.from('opaque-dpapi-ciphertext').toString('base64')
        }
      }
      assert.equal(input, 'opaque-dpapi-ciphertext')
      return {
        status: 0,
        stdout: Buffer.from(protectedPlaintext).toString('base64')
      }
    }
    const secureStore = new WindowsDpapiRefreshTokenStore({ dataRoot: root, runner })
    const binding = new LocalAccountBindingStore({
      secureStore,
      now: () => 1_000
    })
    const version = await binding.completeHandoff({
      deviceSessionId: 'ds_secure',
      refreshToken: 'refresh-secret-never-plaintext',
      accessToken: 'access-memory-only',
      accessTokenExpiresIn: 300
    })
    assert.equal(version, 1)
    const onDisk = fs.readFileSync(path.join(root, 'edge-account-binding.dpapi.json'), 'utf8')
    assert.doesNotMatch(onDisk, /refresh-secret-never-plaintext|access-memory-only/)

    const restarted = new LocalAccountBindingStore({ secureStore, now: () => 2_000 })
    await restarted.initialize()
    const snapshot = restarted.snapshot()
    assert.equal(snapshot.refreshToken, 'refresh-secret-never-plaintext')
    assert.equal(snapshot.accessToken, null)
  })

  it('fails closed to login_required when a persisted secure binding cannot be opened', async () => {
    let clearCalls = 0
    const binding = new LocalAccountBindingStore({
      secureStore: {
        async load() {
          throw new Error('DPAPI unprotect failed')
        },
        async clear() {
          clearCalls += 1
        }
      }
    })

    await binding.initialize()

    assert.equal(binding.snapshot(), null)
    assert.equal(clearCalls, 1)
  })

  it('consumes handoff grants once and serializes binding replacement', async () => {
    const binding = new LocalAccountBindingStore({
      secureStore: new MemoryRefreshTokenStore(),
      now: () => 10_000
    })
    const handoff = new LocalHandoffService({ bindingStore: binding, now: () => 10_000 })
    const grant = handoff.start('code-login-state')
    const completed = await handoff.complete({
      ...grant,
      state: 'code-login-state',
      deviceSessionId: 'ds_one',
      refreshToken: 'refresh-one',
      accessToken: 'access-one',
      accessTokenExpiresIn: 300
    })
    assert.deepEqual(completed, { status: 'completed', bindingVersion: 1 })
    await assert.rejects(() => handoff.complete({
      ...grant,
      state: 'code-login-state',
      deviceSessionId: 'ds_one',
      refreshToken: 'refresh-one',
      accessToken: 'access-one',
      accessTokenExpiresIn: 300
    }), error => error.code === 'handoff_invalid')
  })

  it('coalesces concurrent Access Token refresh and persists only the rotated Refresh Token', async () => {
    const secureStore = new MemoryRefreshTokenStore()
    await secureStore.save({
      deviceSessionId: 'ds_refresh',
      refreshToken: 'old-refresh-token-that-is-long-enough'
    })
    const binding = new LocalAccountBindingStore({
      secureStore,
      now: () => 20_000
    })
    let refreshCalls = 0
    const client = new GatewayClient({
      gatewayOrigin: 'http://127.0.0.1:47920',
      bindingStore: binding,
      now: () => 20_000,
      fetchImpl: async (_url, options) => {
        refreshCalls += 1
        assert.equal(JSON.parse(options.body.toString()).grantType, 'refresh_token')
        await new Promise(resolve => setTimeout(resolve, 20))
        return new Response(JSON.stringify({
          accessToken: 'rotated-access',
          accessTokenExpiresIn: 300,
          refreshToken: 'rotated-refresh',
          deviceSessionId: 'ds_refresh'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    await client.initialize()
    const [first, second, third] = await Promise.all([
      client.getAuthenticatedSnapshot(),
      client.getAuthenticatedSnapshot(),
      client.getAuthenticatedSnapshot()
    ])
    assert.equal(refreshCalls, 1)
    assert.equal(first.accessToken, 'rotated-access')
    assert.equal(second.bindingVersion, first.bindingVersion)
    assert.equal(third.refreshToken, 'rotated-refresh')
    assert.equal((await secureStore.load()).refreshToken, 'rotated-refresh')
  })

  it('passes the macOS Keychain password over stdin instead of process arguments', async () => {
    const root = testRoot('keychain')
    const calls = []
    const runner = (_command, args, options) => {
      calls.push({
        args: [...args],
        input: options.input ? Buffer.from(options.input).toString('utf8') : null
      })
      if (args[0] === 'find-generic-password') {
        return { status: 0, stdout: 'refresh-from-keychain\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const store = new MacKeychainRefreshTokenStore({
      dataRoot: root,
      runner,
      service: 'ai-editor-test',
      account: 'test-account'
    })
    await store.save({
      deviceSessionId: 'ds_mac',
      refreshToken: 'refresh-mac-secret'
    })
    assert.equal(calls[0].args.at(-1), '-w')
    assert.equal(calls[0].args.includes('refresh-mac-secret'), false)
    assert.equal(calls[0].input, 'refresh-mac-secret\n')
    const metadata = fs.readFileSync(
      path.join(root, 'edge-account-binding.keychain.json'),
      'utf8'
    )
    assert.doesNotMatch(metadata, /refresh-mac-secret/)

    const loaded = await store.load()
    assert.deepEqual(loaded, {
      deviceSessionId: 'ds_mac',
      refreshToken: 'refresh-from-keychain'
    })
    await store.clear()
    assert.equal(
      fs.existsSync(path.join(root, 'edge-account-binding.keychain.json')),
      false
    )
  })
})
