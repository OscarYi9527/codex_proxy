import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

test('config reload preserves the exported runtime object identity', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-config-reload-'))
  const previousStorageRoot = process.env.CODEX_PROXY_STORAGE_ROOT
  process.env.CODEX_PROXY_STORAGE_ROOT = storageRoot

  try {
    const moduleUrl = pathToFileURL(
      path.resolve('src', 'config.js')
    )
    moduleUrl.searchParams.set('reload-identity-test', String(Date.now()))
    const config = await import(moduleUrl.href)
    const runtimeReference = config.proxyConfig

    config.saveProxyConfig({ defaultModel: 'reload-identity-model' })
    const reloaded = config.reloadProxyConfig()

    assert.strictEqual(config.proxyConfig, runtimeReference)
    assert.strictEqual(reloaded, runtimeReference)
    assert.equal(runtimeReference.defaultModel, 'reload-identity-model')
  } finally {
    if (previousStorageRoot === undefined) {
      delete process.env.CODEX_PROXY_STORAGE_ROOT
    } else {
      process.env.CODEX_PROXY_STORAGE_ROOT = previousStorageRoot
    }
    fs.rmSync(storageRoot, { recursive: true, force: true })
  }
})
