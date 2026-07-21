import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonAccountStore } from '../src/account-store.js'
import { applyAccountUsage, withAccountStore } from '../src/chatgpt-accounts.js'
import { proxyConfig } from '../src/config.js'

describe('批量账号持久化', () => {
  it('合并同一批次的账号变更并只调用一次持久化', async () => {
    const accounts = [
      { id: 'account-a', label: 'A', status: 'active' },
      { id: 'account-b', label: 'B', status: 'active' }
    ]
    const writes = []
    const store = new JsonAccountStore({
      getAccounts: () => accounts,
      patchManyImpl: updates => writes.push(structuredClone(updates))
    })

    accounts[0].status = 'checking'
    store.captureAccount(accounts[0])
    accounts[0].status = 'active'
    accounts[0].health_check = { state: 'healthy' }
    store.captureAccount(accounts[0])
    accounts[1].usage_sync_status = 'synced'
    store.captureAccount(accounts[1])

    const result = await store.flush()
    assert.strictEqual(writes.length, 1)
    assert.strictEqual(result.config_writes, 1)
    assert.strictEqual(result.accounts_patched, 2)
    assert.deepStrictEqual(writes[0], [
      {
        id: 'account-a',
        patch: {
          status: 'active',
          health_check: { state: 'healthy' }
        }
      },
      {
        id: 'account-b',
        patch: { usage_sync_status: 'synced' }
      }
    ])
    assert.deepStrictEqual(await store.flush(), {
      accounts_patched: 0,
      health_events_appended: 0,
      config_writes: 0,
      health_event_writes: 0
    })
  })

  it('只提交任务实际修改的字段，不回退并发更新的名称或 Refresh Token', async () => {
    const taskAccount = {
      id: 'account-a',
      label: 'old label',
      status: 'active',
      refresh_token: 'old-refresh-token'
    }
    let currentAccounts = [taskAccount]
    let updates = null
    const store = new JsonAccountStore({
      getAccounts: () => currentAccounts,
      patchManyImpl: value => { updates = structuredClone(value) }
    })

    taskAccount.health_check = { state: 'healthy' }
    store.captureAccount(taskAccount)
    currentAccounts = [{
      ...taskAccount,
      label: 'new label',
      refresh_token: 'rotated-refresh-token'
    }]
    await store.flush()

    assert.deepStrictEqual(updates, [{
      id: 'account-a',
      patch: { health_check: { state: 'healthy' } }
    }])
  })

  it('健康事件使用白名单字段并在一次 flush 中写入', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-health-store-'))
    const healthEventsFile = path.join(directory, 'events.json')
    try {
      const store = new JsonAccountStore({
        getAccounts: () => [],
        patchManyImpl: () => assert.fail('No account patch should be written'),
        healthEventsFile
      })
      store.appendHealthEvents([{
        id: 'event-1',
        account_id: 'account-a',
        task_id: 'task-a',
        state: 'healthy',
        checked_at: '2026-07-21T00:00:00.000Z',
        access_token: 'must-not-be-persisted'
      }])
      const result = await store.flush()
      const saved = JSON.parse(fs.readFileSync(healthEventsFile, 'utf8'))
      assert.strictEqual(result.health_event_writes, 1)
      assert.strictEqual(saved.events.length, 1)
      assert.strictEqual(saved.events[0].account_id, 'account-a')
      assert.ok(!JSON.stringify(saved).includes('must-not-be-persisted'))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('AsyncLocalStorage 将现有账号更新导向批量 store', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const account = {
      id: 'batched-usage-account',
      account_id: 'upstream-batched',
      status: 'active',
      usage: {}
    }
    const captured = []
    const store = {
      captureAccount: value => captured.push(structuredClone(value)),
      flush: async () => ({})
    }
    proxyConfig.chatgptAccounts = [account]
    try {
      await withAccountStore(store, async () => {
        applyAccountUsage(account.id, {
          complete_windows: true,
          primary: { remaining_percent: 90 },
          secondary: null
        })
      })
      assert.strictEqual(captured.length, 1)
      assert.strictEqual(captured[0].usage_sync_status, 'synced')
      assert.strictEqual(captured[0].usage.primary.remaining_percent, 90)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
    }
  })
})
