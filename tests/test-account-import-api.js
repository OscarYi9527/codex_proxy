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

      const payloadSegment = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
      })).toString('base64url')
      const temporaryResponse = await fetch(`${base}/admin/api/chatgpt-accounts/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: JSON.stringify({
            name: 'Temporary CPA',
            email: 'temporary@example.test',
            access_token: `header.${payloadSegment}.signature`,
            account_id: 'account-import-temporary',
            refresh_token: ''
          }),
          routingEnabled: true
        })
      })
      const temporary = await temporaryResponse.json()
      assert.equal(temporaryResponse.status, 200)
      assert.equal(temporary.result.imported, 1)
      assert.equal(temporary.result.temporary, 1)
      assert.equal(temporary.result.refreshable, 0)
      assert.equal(temporary.result.incompatible, 0)
      const temporaryAccount = temporary.config.chatgptAccounts.find(
        account => account.account_id === 'account-import-temporary'
      )
      assert.equal(temporaryAccount.credential_mode, 'temporary_access')
      assert.equal(temporaryAccount.credential_compatibility, 'codex_subscription')
      assert.equal(temporaryAccount.routing_enabled, true)
      assert.ok(temporaryAccount.expires_at > Date.now())
      assert.doesNotMatch(JSON.stringify(temporary), /header\./)

      const upgradeResponse = await fetch(`${base}/admin/api/chatgpt-accounts/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: JSON.stringify({
            name: 'Temporary CPA upgraded',
            access_token: `header.${payloadSegment}.replacement`,
            refresh_token: 'refresh.upgrade.signature',
            account_id: 'account-import-temporary'
          })
        })
      })
      const upgraded = await upgradeResponse.json()
      assert.equal(upgradeResponse.status, 200)
      assert.equal(upgraded.result.imported, 1)
      assert.equal(upgraded.result.upgraded, 1)
      assert.equal(upgraded.result.temporary, 0)
      assert.equal(upgraded.result.refreshable, 1)
      const upgradedAccount = upgraded.config.chatgptAccounts.find(
        account => account.account_id === 'account-import-temporary'
      )
      assert.equal(upgradedAccount.credential_mode, 'refreshable')
      assert.equal(upgradedAccount.temporary_imported_at, null)

      const incompatiblePayload = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        client_id: 'app_other_client'
      })).toString('base64url')
      const incompatibleResponse = await fetch(`${base}/admin/api/chatgpt-accounts/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: JSON.stringify({
            access_token: `header.${incompatiblePayload}.signature`,
            account_id: 'account-import-incompatible'
          }),
          routingEnabled: true
        })
      })
      const incompatible = await incompatibleResponse.json()
      assert.equal(incompatibleResponse.status, 200)
      assert.equal(incompatible.result.incompatible, 1)
      const incompatibleAccount = incompatible.config.chatgptAccounts.find(
        account => account.account_id === 'account-import-incompatible'
      )
      assert.equal(incompatibleAccount.credential_compatibility, 'incompatible_oauth_client')
      assert.equal(incompatibleAccount.routing_enabled, false)
      assert.equal(incompatibleAccount.status, 'auth_error')

      const enableIncompatibleResponse = await fetch(
        `${base}/admin/api/chatgpt-accounts/${encodeURIComponent(incompatibleAccount.id)}/routing`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true })
        }
      )
      const enableIncompatible = await enableIncompatibleResponse.json()
      assert.equal(enableIncompatibleResponse.status, 400)
      assert.match(enableIncompatible.error.message, /不能启用订阅路由/)
      const configAfterRejectedEnable = await (
        await fetch(`${base}/admin/api/config`)
      ).json()
      assert.equal(configAfterRejectedEnable.config.chatgptAccounts.find(
        account => account.id === incompatibleAccount.id
      ).routing_enabled, false)

      const expiredPayload = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) - 60,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
      })).toString('base64url')
      const mixedResponse = await fetch(`${base}/admin/api/chatgpt-accounts/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: JSON.stringify([
            {
              access_token: `header.${expiredPayload}.expired`,
              account_id: 'account-import-expired'
            },
            {
              access_token: `header.${payloadSegment}.valid`,
              account_id: 'account-import-valid-after-expired'
            }
          ])
        })
      })
      const mixed = await mixedResponse.json()
      assert.equal(mixedResponse.status, 200)
      assert.equal(mixed.result.imported, 1)
      assert.equal(mixed.result.rejected, 1)
      assert.equal(mixed.result.rejections[0].accountId, 'account-import-expired')
      assert.match(mixed.result.rejections[0].reason, /已过期/)
      assert.ok(mixed.config.chatgptAccounts.some(
        account => account.account_id === 'account-import-valid-after-expired'
      ))
    } finally {
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(storageRoot, { recursive: true, force: true })
      delete process.env.CODEX_PROXY_STORAGE_ROOT
    }
  })
})
