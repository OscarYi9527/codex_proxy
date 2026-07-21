import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountCheckTaskManager,
  accountCheckTaskOptionsFromEnv
} from '../src/account-check-tasks.js'
import { JsonAccountStore } from '../src/account-store.js'
import { atomicWriteJson } from '../src/config.js'
import { createServer } from '../src/server.js'

function healthyResult(account) {
  return {
    state: 'healthy',
    label: '基础检查正常',
    severity: 'healthy',
    retryable: false,
    reason: 'ok',
    checked_at: new Date().toISOString(),
    http_status: null,
    error_code: null,
    usage_synced: true,
    reset_credits_synced: true,
    remaining_percent: 100,
    source: 'status_check',
    account_id: account.id
  }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}

function temporaryManager(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-check-tasks-'))
  const stateFile = path.join(directory, 'tasks.json')
  const healthEventsFile = path.join(directory, 'health-events.json')
  return {
    directory,
    stateFile,
    healthEventsFile,
    manager: new AccountCheckTaskManager({
      stateFile,
      jitterMinMs: 0,
      jitterMaxMs: 0,
      ...options
    })
  }
}

describe('后台账号检查任务', () => {
  it('并发、批次、超时和抖动可通过受限环境变量配置', () => {
    assert.deepStrictEqual(accountCheckTaskOptionsFromEnv({
      CODEX_ACCOUNT_CHECK_CONCURRENCY: '4',
      CODEX_ACCOUNT_CHECK_BATCH_SIZE: '40',
      CODEX_ACCOUNT_CHECK_TIMEOUT_MS: '90000',
      CODEX_ACCOUNT_CHECK_JITTER_MIN_MS: '10',
      CODEX_ACCOUNT_CHECK_JITTER_MAX_MS: '20'
    }), {
      concurrency: 4,
      batchSize: 40,
      accountTimeoutMs: 90000,
      jitterMinMs: 10,
      jitterMaxMs: 20
    })
    assert.strictEqual(accountCheckTaskOptionsFromEnv({
      CODEX_ACCOUNT_CHECK_CONCURRENCY: '99'
    }).concurrency, 4)
  })

  it('套餐不支持重置次数不会被计为账号故障', async () => {
    const accounts = [{ id: 'unsupported-reset-account' }]
    const fixture = temporaryManager({
      getAccounts: () => accounts,
      createStore: () => ({
        captureAccount() {},
        appendHealthEvents() {},
        async flush() {}
      }),
      checkAccount: async account => ({
        ...healthyResult(account),
        reset_credits_synced: false,
        reset_credit_status: 'unsupported'
      })
    })
    try {
      const started = fixture.manager.start()
      const completed = await fixture.manager.wait(started.task.id)
      assert.strictEqual(completed.status, 'completed')
      assert.strictEqual(completed.healthy, 1)
      assert.strictEqual(completed.issues, 0)
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('管理 API 提供创建、列表、进度、取消和恢复合同', async () => {
    const task = {
      id: 'api-task',
      status: 'running',
      total: 2,
      processed: 1,
      pending: 1,
      healthy: 1,
      issues: 0,
      summary: { healthy: 1 },
      accounts: [],
      can_cancel: true,
      can_resume: false,
      progress_percent: 50,
      probe_scope: 'credential_usage_and_reset_credits_without_model_request'
    }
    const calls = []
    const manager = {
      start() {
        calls.push('start')
        return { task, created: true }
      },
      list() {
        calls.push('list')
        return [task]
      },
      get(taskId) {
        calls.push(`get:${taskId}`)
        return taskId === task.id ? { ...task, status: 'completed' } : null
      },
      cancel(taskId) {
        calls.push(`cancel:${taskId}`)
        return { ...task, status: 'cancelling' }
      },
      resume(taskId) {
        calls.push(`resume:${taskId}`)
        return { ...task, status: 'queued' }
      }
    }
    const server = createServer({ accountCheckTasks: manager })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const base = `http://127.0.0.1:${server.address().port}/admin/api/chatgpt-accounts`
      const started = await fetch(`${base}/check-all`, { method: 'POST' })
      assert.strictEqual(started.status, 202)
      assert.strictEqual((await started.json()).task.id, task.id)

      const listed = await fetch(`${base}/check-tasks`)
      assert.strictEqual(listed.status, 200)
      assert.strictEqual((await listed.json()).tasks.length, 1)

      const progress = await fetch(`${base}/check-tasks/${task.id}`)
      assert.strictEqual(progress.status, 200)
      assert.strictEqual((await progress.json()).task.status, 'completed')

      const cancelled = await fetch(`${base}/check-tasks/${task.id}/cancel`, { method: 'POST' })
      assert.strictEqual(cancelled.status, 202)
      assert.strictEqual((await cancelled.json()).task.status, 'cancelling')

      const resumed = await fetch(`${base}/check-tasks/${task.id}/resume`, { method: 'POST' })
      assert.strictEqual(resumed.status, 202)
      assert.strictEqual((await resumed.json()).task.status, 'queued')

      const missing = await fetch(`${base}/check-tasks/missing`)
      assert.strictEqual(missing.status, 404)
      assert.deepStrictEqual(calls, [
        'start',
        'list',
        'get:api-task',
        'cancel:api-task',
        'resume:api-task',
        'get:missing'
      ])
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('300 个账号按批次持久化，并可查询完整进度且不写入 Token', async () => {
    const accounts = Array.from({ length: 300 }, (_, index) => ({
      id: `account-${index}`,
      label: `Account ${index}`,
      access_token: `secret-access-token-${index}`,
      status: 'active'
    }))
    let activeStore = null
    const configWrites = []
    const fixture = temporaryManager({
      getAccounts: () => accounts,
      batchSize: 25,
      concurrency: 5,
      createStore: () => new JsonAccountStore({
        getAccounts: () => accounts,
        patchManyImpl: updates => configWrites.push(structuredClone(updates)),
        healthEventsFile: null
      }),
      withStore: async (store, callback) => {
        activeStore = store
        try {
          return await callback()
        } finally {
          activeStore = null
        }
      },
      checkAccount: async account => {
        account.status = 'checking'
        activeStore.captureAccount(account)
        account.status = 'active'
        account.health_check = { state: 'healthy' }
        activeStore.captureAccount(account)
        return healthyResult(account)
      }
    })
    try {
      // Disable the sidecar writer for this high-volume test while retaining
      // the real batch patch behavior.
      fixture.manager.createStore = () => {
        const store = new JsonAccountStore({
          getAccounts: () => accounts,
          patchManyImpl: updates => configWrites.push(structuredClone(updates))
        })
        store.appendHealthEvents = () => {}
        return store
      }
      const started = fixture.manager.start()
      const completed = await fixture.manager.wait(started.task.id)
      assert.strictEqual(completed.status, 'completed')
      assert.strictEqual(completed.processed, 300)
      assert.strictEqual(completed.progress_percent, 100)
      assert.strictEqual(completed.healthy, 300)
      assert.strictEqual(configWrites.length, 12)
      assert.ok(configWrites.every(batch => batch.length === 25))
      const saved = fs.readFileSync(fixture.stateFile, 'utf8')
      assert.ok(!saved.includes('secret-access-token'))
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('取消只等待在途账号，随后可从剩余账号恢复', async () => {
    const accounts = Array.from({ length: 6 }, (_, index) => ({
      id: `cancel-${index}`,
      label: `Cancel ${index}`
    }))
    let releaseFirstBatch
    const firstBatchGate = new Promise(resolve => { releaseFirstBatch = resolve })
    let startedChecks = 0
    let gateEnabled = true
    const fixture = temporaryManager({
      getAccounts: () => accounts,
      batchSize: 6,
      concurrency: 2,
      createStore: () => ({
        captureAccount() {},
        appendHealthEvents() {},
        async flush() {}
      }),
      checkAccount: async account => {
        startedChecks++
        if (gateEnabled) await firstBatchGate
        return healthyResult(account)
      }
    })
    try {
      const started = fixture.manager.start()
      await waitUntil(() => startedChecks === 2)
      const cancelling = fixture.manager.cancel(started.task.id)
      assert.strictEqual(cancelling.status, 'cancelling')
      gateEnabled = false
      releaseFirstBatch()
      const cancelled = await fixture.manager.wait(started.task.id)
      assert.strictEqual(cancelled.status, 'cancelled')
      assert.strictEqual(cancelled.processed, 2)
      assert.strictEqual(cancelled.pending, 4)
      assert.strictEqual(cancelled.can_resume, true)

      const resumed = fixture.manager.resume(started.task.id)
      assert.strictEqual(resumed.status, 'queued')
      const completed = await fixture.manager.wait(started.task.id)
      assert.strictEqual(completed.status, 'completed')
      assert.strictEqual(completed.processed, 6)
      assert.strictEqual(completed.pending, 0)
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('进程中断任务会从最后持久化批次自动恢复', async () => {
    const accounts = [
      { id: 'recovery-a' },
      { id: 'recovery-b' },
      { id: 'recovery-c' }
    ]
    const fixture = temporaryManager({
      getAccounts: () => accounts,
      createStore: () => ({
        captureAccount() {},
        appendHealthEvents() {},
        async flush() {}
      }),
      checkAccount: async account => healthyResult(account)
    })
    const createdAt = '2026-07-21T00:00:00.000Z'
    atomicWriteJson(fixture.stateFile, {
      schema_version: 1,
      tasks: [{
        id: 'recover-task',
        type: 'account_health_check',
        status: 'running',
        created_at: createdAt,
        started_at: createdAt,
        updated_at: createdAt,
        completed_at: null,
        total: 3,
        account_ids: accounts.map(account => account.id),
        pending_account_ids: ['recovery-b', 'recovery-c'],
        results: [{
          id: 'recovery-a',
          ...healthyResult(accounts[0])
        }],
        cancel_requested: false,
        error: null,
        probe_scope: 'credential_usage_and_reset_credits_without_model_request'
      }]
    })
    try {
      fixture.manager.initialize({ autoResume: true })
      const completed = await fixture.manager.wait('recover-task')
      assert.strictEqual(completed.status, 'completed')
      assert.strictEqual(completed.processed, 3)
      assert.deepStrictEqual(
        completed.accounts.map(account => account.id),
        ['recovery-a', 'recovery-b', 'recovery-c']
      )
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('单账号超时不会阻塞后续账号', async () => {
    const accounts = [{ id: 'timeout-account' }, { id: 'healthy-account' }]
    const fixture = temporaryManager({
      getAccounts: () => accounts,
      batchSize: 2,
      concurrency: 1,
      accountTimeoutMs: 1000,
      fetchImpl: (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      }),
      createStore: () => ({
        captureAccount() {},
        appendHealthEvents() {},
        async flush() {}
      }),
      checkAccount: async (account, fetchImpl) => {
        if (account.id === 'timeout-account') await fetchImpl('https://timeout.test')
        return healthyResult(account)
      }
    })
    try {
      const startedAt = Date.now()
      const started = fixture.manager.start()
      const completed = await fixture.manager.wait(started.task.id)
      assert.strictEqual(completed.status, 'completed')
      assert.strictEqual(completed.processed, 2)
      assert.strictEqual(completed.accounts[0].state, 'unknown_error')
      assert.strictEqual(completed.accounts[1].state, 'healthy')
      assert.ok(Date.now() - startedAt < 2500)
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('批次写入失败不会提交进度，修复后可重试', async () => {
    const accounts = [{ id: 'write-failure-a' }, { id: 'write-failure-b' }]
    let failWrites = true
    let reloads = 0
    const fixture = temporaryManager({
      getAccounts: () => accounts,
      createStore: () => ({
        captureAccount() {},
        appendHealthEvents() {},
        async flush() {
          if (failWrites) throw new Error('injected account store write failure')
        }
      }),
      reloadAccounts: () => { reloads++ },
      checkAccount: async account => healthyResult(account)
    })
    try {
      const started = fixture.manager.start()
      const failed = await fixture.manager.wait(started.task.id)
      assert.strictEqual(failed.status, 'failed')
      assert.strictEqual(failed.processed, 0)
      assert.strictEqual(failed.pending, 2)
      assert.strictEqual(reloads, 1)

      failWrites = false
      fixture.manager.resume(started.task.id)
      const completed = await fixture.manager.wait(started.task.id)
      assert.strictEqual(completed.status, 'completed')
      assert.strictEqual(completed.processed, 2)
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
})
