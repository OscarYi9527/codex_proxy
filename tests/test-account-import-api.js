import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('账号文件快捷导入 API', () => {
  it('批量导入 sub2 JSON、默认仅保存并跳过重复账号', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-import-api-'))
    process.env.CODEX_PROXY_STORAGE_ROOT = storageRoot
    const { createServer } = await import(`../src/server.js?account-import=${Date.now()}`)
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const { port } = server.address()
      const base = `http://127.0.0.1:${port}`
      const content = JSON.stringify({
        accounts: [{
          name: 'Imported sub2 account',
          credentials: {
            access_token: 'header.api.signature',
            refresh_token: 'refresh.api.signature',
            id_token: 'identity.api.signature',
            account_id: 'account-import-api'
          }
        }]
      })
      const importOnce = async () => {
        const response = await fetch(`${base}/admin/api/chatgpt-accounts/import`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content })
        })
        return { response, payload: await response.json() }
      }

      const first = await importOnce()
      assert.equal(first.response.status, 200)
      assert.equal(first.payload.result.imported, 1)
      assert.equal(first.payload.result.skipped, 0)
      assert.equal(first.payload.config.chatgptAccounts[0].routing_enabled, false)
      assert.doesNotMatch(JSON.stringify(first.payload), /header\.api|refresh\.api|identity\.api/)

      const duplicate = await importOnce()
      assert.equal(duplicate.response.status, 200)
      assert.equal(duplicate.payload.result.imported, 0)
      assert.equal(duplicate.payload.result.skipped, 1)
      assert.equal(duplicate.payload.config.chatgptAccounts.length, 1)
    } finally {
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(storageRoot, { recursive: true, force: true })
      delete process.env.CODEX_PROXY_STORAGE_ROOT
    }
  })
})
