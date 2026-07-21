import fs from 'node:fs'
import path from 'node:path'
import { JsonAccountStore } from './account-store.js'
import {
  checkChatgptAccountStatus,
  withAccountStore
} from './chatgpt-accounts.js'
import {
  STORAGE_ROOT,
  atomicWriteJson,
  proxyConfig,
  reloadProxyConfig
} from './config.js'
import { chinaFetch } from './china-fetch.js'
import { redactSecrets } from './logger.js'
import { id } from './server-utils.js'

export const ACCOUNT_CHECK_TASKS_FILE = path.join(
  STORAGE_ROOT,
  'codex-proxy-account-check-tasks.json'
)

const ACTIVE_TASK_STATES = new Set(['queued', 'running', 'cancelling'])
const RESUMABLE_TASK_STATES = new Set(['cancelled', 'failed', 'interrupted'])
const PROBE_SCOPE = 'credential_usage_and_reset_credits_without_model_request'

function safeError(error) {
  return redactSecrets(String(error?.message || error || 'Unknown task failure')).slice(0, 300)
}

function clone(value) {
  return structuredClone(value)
}

function iso(now) {
  return new Date(now).toISOString()
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

export function accountCheckTaskOptionsFromEnv(env = process.env) {
  const jitterMinMs = boundedInteger(
    env.CODEX_ACCOUNT_CHECK_JITTER_MIN_MS,
    150,
    0,
    5000
  )
  const jitterMaxMs = boundedInteger(
    env.CODEX_ACCOUNT_CHECK_JITTER_MAX_MS,
    600,
    jitterMinMs,
    10_000
  )
  return {
    concurrency: boundedInteger(env.CODEX_ACCOUNT_CHECK_CONCURRENCY, 2, 1, 4),
    batchSize: boundedInteger(env.CODEX_ACCOUNT_CHECK_BATCH_SIZE, 20, 1, 100),
    accountTimeoutMs: boundedInteger(
      env.CODEX_ACCOUNT_CHECK_TIMEOUT_MS,
      45_000,
      1000,
      120_000
    ),
    jitterMinMs,
    jitterMaxMs
  }
}

function taskResultForError(account, error, checkedAt) {
  return {
    id: account.id,
    account_label: account.label || account.email || account.account_id || account.id,
    routing_enabled: account.routing_enabled !== false,
    state: 'unknown_error',
    label: '未知异常',
    severity: 'warning',
    retryable: true,
    reason: safeError(error),
    checked_at: checkedAt,
    http_status: Number(error?.status) || null,
    error_code: error?.code ? String(error.code).slice(0, 80) : null,
    usage_synced: false,
    reset_credits_synced: false,
    remaining_percent: null
  }
}

function missingAccountResult(accountId, checkedAt) {
  return {
    id: accountId,
    account_label: accountId,
    routing_enabled: false,
    state: 'account_missing',
    label: '账号已移除',
    severity: 'warning',
    retryable: false,
    reason: '任务执行期间账号已被移除，因此跳过检查。',
    checked_at: checkedAt,
    http_status: null,
    error_code: 'ACCOUNT_REMOVED_DURING_TASK',
    usage_synced: false,
    reset_credits_synced: false,
    remaining_percent: null
  }
}

function summarize(results) {
  const summary = {}
  for (const result of results) summary[result.state] = (summary[result.state] || 0) + 1
  const healthy = Number(summary.healthy || 0)
  const issues = results.filter(result =>
    result.state !== 'healthy' ||
    (
      result.reset_credits_synced !== true &&
      result.reset_credit_status !== 'unsupported'
    )
  ).length
  return { summary, healthy, issues }
}

function readTaskDocument(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed?.tasks) ? parsed.tasks : []
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
}

export class AccountCheckTaskManager {
  constructor({
    stateFile = ACCOUNT_CHECK_TASKS_FILE,
    getAccounts = () => proxyConfig.chatgptAccounts || [],
    checkAccount = (account, fetchImpl) => checkChatgptAccountStatus(account, fetchImpl),
    fetchImpl = chinaFetch(fetch),
    createStore = () => new JsonAccountStore(),
    withStore = withAccountStore,
    reloadAccounts = reloadProxyConfig,
    writeJson = atomicWriteJson,
    now = () => Date.now(),
    createId = () => id('account-check'),
    batchSize = 20,
    concurrency = 2,
    accountTimeoutMs = 45_000,
    jitterMinMs = 150,
    jitterMaxMs = 600,
    random = Math.random,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    maxTasks = 20
  } = {}) {
    this.stateFile = stateFile
    this.getAccounts = getAccounts
    this.checkAccount = checkAccount
    this.fetchImpl = fetchImpl
    this.createStore = createStore
    this.withStore = withStore
    this.reloadAccounts = reloadAccounts
    this.writeJson = writeJson
    this.now = now
    this.createId = createId
    this.batchSize = Math.max(1, Math.floor(batchSize))
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.accountTimeoutMs = Math.max(1000, Math.floor(accountTimeoutMs))
    this.jitterMinMs = Math.max(0, Math.floor(jitterMinMs))
    this.jitterMaxMs = Math.max(this.jitterMinMs, Math.floor(jitterMaxMs))
    this.random = random
    this.delay = delay
    this.maxTasks = Math.max(1, Math.floor(maxTasks))
    this.tasks = []
    this.loaded = false
    this.running = new Map()
  }

  initialize({ autoResume = true } = {}) {
    if (this.loaded) return this.list()
    this.tasks = readTaskDocument(this.stateFile)
    this.loaded = true
    let changed = false
    for (const task of this.tasks) {
      if (!ACTIVE_TASK_STATES.has(task.status)) continue
      task.status = 'interrupted'
      task.cancel_requested = false
      task.updated_at = iso(this.now())
      task.error = '进程在任务完成前退出；任务可从最后一个已提交批次恢复。'
      changed = true
    }
    if (changed) this.#persist()
    if (autoResume) {
      const task = this.tasks
        .filter(item => item.status === 'interrupted')
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0]
      if (task) {
        task.status = 'queued'
        task.error = null
        task.updated_at = iso(this.now())
        this.#persist()
        this.#schedule(task.id)
      }
    }
    return this.list()
  }

  list() {
    this.#ensureLoaded()
    return this.tasks
      .slice()
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .map(task => this.#publicTask(task))
  }

  get(taskId) {
    this.#ensureLoaded()
    const task = this.tasks.find(item => item.id === taskId)
    return task ? this.#publicTask(task) : null
  }

  start() {
    this.#ensureLoaded()
    const active = this.tasks.find(task => ACTIVE_TASK_STATES.has(task.status))
    if (active) return { task: this.#publicTask(active), created: false }

    const accounts = this.getAccounts()
    const createdAt = iso(this.now())
    const task = {
      id: this.createId(),
      type: 'account_health_check',
      status: 'queued',
      created_at: createdAt,
      started_at: null,
      updated_at: createdAt,
      completed_at: null,
      total: accounts.length,
      account_ids: accounts.map(account => account.id),
      pending_account_ids: accounts.map(account => account.id),
      results: [],
      in_flight_account_ids: [],
      cancel_requested: false,
      error: null,
      probe_scope: PROBE_SCOPE
    }
    this.tasks.push(task)
    this.#prune()
    this.#persist()
    this.#schedule(task.id)
    return { task: this.#publicTask(task), created: true }
  }

  cancel(taskId) {
    this.#ensureLoaded()
    const task = this.tasks.find(item => item.id === taskId)
    if (!task) return null
    if (!ACTIVE_TASK_STATES.has(task.status)) return this.#publicTask(task)
    task.cancel_requested = true
    task.updated_at = iso(this.now())
    if (task.status === 'queued') {
      task.status = 'cancelled'
      task.completed_at = task.updated_at
    } else {
      task.status = 'cancelling'
    }
    this.#persist()
    return this.#publicTask(task)
  }

  resume(taskId) {
    this.#ensureLoaded()
    const task = this.tasks.find(item => item.id === taskId)
    if (!task) return null
    if (!RESUMABLE_TASK_STATES.has(task.status)) return this.#publicTask(task)
    if (!task.pending_account_ids.length) return this.#publicTask(task)
    const otherActive = this.tasks.find(item =>
      item.id !== task.id && ACTIVE_TASK_STATES.has(item.status)
    )
    if (otherActive) {
      const error = new Error('已有账号检查任务正在运行')
      error.code = 'ACCOUNT_CHECK_TASK_ACTIVE'
      throw error
    }
    task.status = 'queued'
    task.cancel_requested = false
    task.completed_at = null
    task.error = null
    task.updated_at = iso(this.now())
    this.#persist()
    this.#schedule(task.id)
    return this.#publicTask(task)
  }

  async wait(taskId) {
    this.#ensureLoaded()
    const running = this.running.get(taskId)
    if (running) await running
    return this.get(taskId)
  }

  #ensureLoaded() {
    if (!this.loaded) this.initialize({ autoResume: false })
  }

  #persist() {
    this.writeJson(this.stateFile, {
      schema_version: 1,
      updated_at: iso(this.now()),
      tasks: this.tasks
    })
  }

  #prune() {
    const active = this.tasks.filter(task => ACTIVE_TASK_STATES.has(task.status))
    const inactive = this.tasks
      .filter(task => !ACTIVE_TASK_STATES.has(task.status))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, this.maxTasks)
    this.tasks = [...active, ...inactive]
  }

  #schedule(taskId) {
    if (this.running.has(taskId)) return this.running.get(taskId)
    const promise = Promise.resolve()
      .then(() => this.#run(taskId))
      .catch(error => {
        const task = this.tasks.find(item => item.id === taskId)
        if (!task) return
        task.status = 'failed'
        task.error = safeError(error)
        task.updated_at = iso(this.now())
        task.completed_at = task.updated_at
        this.#persist()
      })
      .finally(() => {
        if (this.running.get(taskId) === promise) this.running.delete(taskId)
      })
    this.running.set(taskId, promise)
    return promise
  }

  #boundedFetch() {
    return (url, options = {}) => {
      const timeout = new AbortController()
      const timer = setTimeout(() => {
        timeout.abort(new DOMException(
          'The account check request timed out.',
          'TimeoutError'
        ))
      }, this.accountTimeoutMs)
      const signals = [options.signal, timeout.signal].filter(Boolean)
      try {
        return Promise.resolve(this.fetchImpl(url, {
          ...options,
          signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals)
        })).finally(() => clearTimeout(timer))
      } catch (error) {
        clearTimeout(timer)
        throw error
      }
    }
  }

  async #jitter() {
    if (this.jitterMaxMs <= 0) return
    const range = this.jitterMaxMs - this.jitterMinMs
    const milliseconds = this.jitterMinMs + Math.floor(this.random() * (range + 1))
    if (milliseconds > 0) await this.delay(milliseconds)
  }

  async #run(taskId) {
    const task = this.tasks.find(item => item.id === taskId)
    if (!task || task.status !== 'queued') return
    task.status = 'running'
    task.started_at ||= iso(this.now())
    task.updated_at = iso(this.now())
    this.#persist()

    while (task.pending_account_ids.length && !task.cancel_requested) {
      const candidateIds = task.pending_account_ids.slice(0, this.batchSize)
      const processedIds = []
      const batchResults = []
      const store = this.createStore()
      let cursor = 0
      try {
        await this.withStore(store, async () => {
          const worker = async () => {
            while (!task.cancel_requested && cursor < candidateIds.length) {
              const accountId = candidateIds[cursor++]
              const account = this.getAccounts().find(item => item.id === accountId)
              const checkedAt = iso(this.now())
              let result
              task.in_flight_account_ids ||= []
              task.in_flight_account_ids.push(accountId)
              try {
                if (!account) {
                  result = missingAccountResult(accountId, checkedAt)
                } else {
                  const check = await this.checkAccount(account, this.#boundedFetch())
                  result = {
                    id: account.id,
                    account_label: account.label || account.email || account.account_id || account.id,
                    routing_enabled: account.routing_enabled !== false,
                    ...check
                  }
                }
              } catch (error) {
                if (account) {
                  result = taskResultForError(account, error, checkedAt)
                } else {
                  result = missingAccountResult(accountId, checkedAt)
                }
              } finally {
                task.in_flight_account_ids = task.in_flight_account_ids.filter(
                  currentId => currentId !== accountId
                )
              }
              processedIds.push(accountId)
              batchResults.push(result)
              if (!task.cancel_requested && cursor < candidateIds.length) await this.#jitter()
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(this.concurrency, candidateIds.length) }, worker)
          )
          store.appendHealthEvents(batchResults
            .filter(result => !result.first_seen_at)
            .map(result => ({
            id: `${task.id}:${result.id}:${result.checked_at}`,
            account_id: result.id,
            task_id: task.id,
            state: result.state,
            source: result.source,
            probe_scope: result.probe_scope,
            confidence: result.confidence,
            disposition: result.disposition,
            first_seen_at: result.first_seen_at,
            last_seen_at: result.last_seen_at,
            consecutive_failures: result.consecutive_failures,
            checked_at: result.checked_at,
            http_status: result.http_status,
            error_code: result.error_code,
            retry_at: result.retry_at,
            recovered_from: result.recovered_from
          })))
        })
        await store.flush()
      } catch (error) {
        try { this.reloadAccounts() } catch {}
        throw error
      }

      const completed = new Set(processedIds)
      task.pending_account_ids = task.pending_account_ids.filter(accountId => !completed.has(accountId))
      task.results.push(...batchResults)
      task.updated_at = iso(this.now())
      this.#persist()
    }

    const order = new Map(task.account_ids.map((accountId, index) => [accountId, index]))
    task.results.sort((left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    )
    task.updated_at = iso(this.now())
    task.completed_at = task.updated_at
    task.in_flight_account_ids = []
    if (task.cancel_requested) {
      task.status = 'cancelled'
    } else {
      task.status = 'completed'
    }
    task.cancel_requested = false
    this.#persist()
  }

  #publicTask(task) {
    const { summary, healthy, issues } = summarize(task.results || [])
    const processed = (task.results || []).length
    const currentAccounts = (task.in_flight_account_ids || []).map(accountId => {
      const account = this.getAccounts().find(item => item.id === accountId)
      return {
        id: accountId,
        label: account?.label || account?.email || account?.account_id || accountId
      }
    })
    return clone({
      id: task.id,
      type: task.type,
      status: task.status,
      created_at: task.created_at,
      started_at: task.started_at,
      updated_at: task.updated_at,
      completed_at: task.completed_at,
      total: task.total,
      processed,
      pending: Math.max(0, task.total - processed),
      progress_percent: task.total
        ? Number((processed / task.total * 100).toFixed(1))
        : 100,
      healthy,
      issues,
      summary,
      current_accounts: currentAccounts,
      accounts: task.results || [],
      error: task.error,
      probe_scope: task.probe_scope,
      can_cancel: ACTIVE_TASK_STATES.has(task.status),
      can_resume: RESUMABLE_TASK_STATES.has(task.status) &&
        Array.isArray(task.pending_account_ids) &&
        task.pending_account_ids.length > 0
    })
  }
}

export const accountCheckTaskManager = new AccountCheckTaskManager(
  accountCheckTaskOptionsFromEnv()
)

export function initializeAccountCheckTasks(options) {
  return accountCheckTaskManager.initialize(options)
}
