import fs from 'node:fs'
import path from 'node:path'
import {
  STORAGE_ROOT,
  atomicWriteJson,
  patchChatgptAccounts,
  proxyConfig
} from './config.js'

export const ACCOUNT_HEALTH_EVENTS_FILE = path.join(
  STORAGE_ROOT,
  'codex-proxy-account-health-events.json'
)

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function sameJson(left, right) {
  if (left === right) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

function accountPatch(previous = {}, current = {}) {
  const patch = {}
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (sameJson(previous[key], current[key])) continue
    patch[key] = clone(current[key])
  }
  return patch
}

function safeHealthEvent(event) {
  const source = event && typeof event === 'object' ? event : {}
  return {
    id: String(source.id || ''),
    account_id: String(source.account_id || ''),
    task_id: source.task_id ? String(source.task_id) : null,
    state: String(source.state || 'unknown'),
    source: String(source.source || 'account_check'),
    checked_at: String(source.checked_at || new Date().toISOString()),
    http_status: Number.isFinite(Number(source.http_status)) ? Number(source.http_status) : null,
    error_code: source.error_code ? String(source.error_code).slice(0, 120) : null,
    retry_at: source.retry_at ? String(source.retry_at) : null
  }
}
function readHealthEvents(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed?.events) ? parsed.events : []
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
}

export class JsonAccountStore {
  constructor({
    getAccounts = () => proxyConfig.chatgptAccounts || [],
    patchManyImpl = updates => patchChatgptAccounts(updates),
    healthEventsFile = ACCOUNT_HEALTH_EVENTS_FILE,
    writeJson = atomicWriteJson,
    maxHealthEvents = 5000
  } = {}) {
    this.getAccounts = getAccounts
    this.patchManyImpl = patchManyImpl
    this.healthEventsFile = healthEventsFile
    this.writeJson = writeJson
    this.maxHealthEvents = maxHealthEvents
    this.pendingPatches = new Map()
    this.pendingHealthEvents = []
    this.snapshots = new Map(
      getAccounts().map(account => [account.id, clone(account)])
    )
  }

  patchAccount(id, patch) {
    const accountId = String(id || '').trim()
    if (!accountId) throw new Error('Account patch requires an id')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`Account patch ${accountId} must be an object`)
    }
    const current = this.getAccounts().find(account => account.id === accountId)
    if (!current) return false
    const copiedPatch = clone(patch)
    Object.assign(current, copiedPatch)
    this.pendingPatches.set(accountId, {
      ...(this.pendingPatches.get(accountId) || {}),
      ...copiedPatch
    })
    this.snapshots.set(accountId, clone(current))
    return true
  }

  patchMany(updates) {
    if (!Array.isArray(updates)) throw new Error('Account patches must be an array')
    let patched = 0
    for (const update of updates) {
      if (this.patchAccount(update?.id, update?.patch)) patched++
    }
    return patched
  }

  captureAccount(account) {
    if (!account?.id) throw new Error('Persisted account requires an id')
    const previous = this.snapshots.get(account.id) || {}
    const patch = accountPatch(previous, account)
    if (Object.keys(patch).length) {
      this.pendingPatches.set(account.id, {
        ...(this.pendingPatches.get(account.id) || {}),
        ...patch
      })
    }
    this.snapshots.set(account.id, clone(account))
    return patch
  }

  appendHealthEvents(events) {
    if (!Array.isArray(events)) throw new Error('Health events must be an array')
    this.pendingHealthEvents.push(...events.map(safeHealthEvent))
  }

  async flush() {
    const updates = [...this.pendingPatches].map(([id, patch]) => ({ id, patch }))
    const events = this.pendingHealthEvents.slice()
    if (updates.length) this.patchManyImpl(updates)
    if (events.length) {
      const existing = readHealthEvents(this.healthEventsFile)
      this.writeJson(this.healthEventsFile, {
        schema_version: 1,
        events: [...existing, ...events].slice(-this.maxHealthEvents)
      })
    }
    this.pendingPatches.clear()
    this.pendingHealthEvents.length = 0
    return {
      accounts_patched: updates.length,
      health_events_appended: events.length,
      config_writes: updates.length ? 1 : 0,
      health_event_writes: events.length ? 1 : 0
    }
  }
}
