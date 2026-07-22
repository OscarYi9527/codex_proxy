import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { credentialStoreEnabled, decryptConfigSecrets, encryptConfigSecrets, initializeCredentialStore } from './credential-store.js'
import { backupBeforeMigration, migrateConfigDocument } from './migrations.js'
import { safeErrorText } from './logger.js'
import { assertNoSecrets } from './secret-scan.js'

const PROXY_DIR = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(
  process.env.CODEX_PROXY_STORAGE_ROOT || path.join(PROXY_DIR, '..')
)
const CONFIG_FILE = path.join(STORAGE_ROOT, 'codex-proxy-config.json')
const CONFIG_BACKUP_DIR = path.join(STORAGE_ROOT, '.config-backups')
const ACCOUNT_BACKUP_DIR = path.join(STORAGE_ROOT, '.account-backups')
const MIGRATION_BACKUP_DIR = path.join(STORAGE_ROOT, '.migration-backups')
let credentialProtection = { enabled: false, reason: 'not initialized' }
let warnedDeferredCredentialMigration = false

// A previously initialized install must decrypt before the first config load.
if (process.platform === 'win32' && fs.existsSync(path.join(STORAGE_ROOT, '.credential-key.dpapi.json'))) {
  credentialProtection = initializeCredentialStore(STORAGE_ROOT)
}
const ACCOUNT_STRATEGIES = new Set([
  'priority', 'round-robin', 'headroom', 'least-used', 'latency',
  'reliable', 'weighted', 'random', 'lkgp'
])

const CONFIG_DEFAULTS = {
  deepseekApiKey: '',
  openaiApiKey: '',
  openaiOrgId: '',
  openaiProjectId: '',
  upstreamUrl: 'https://api.deepseek.com/anthropic/v1/messages',
  chatgptResponsesUrl: 'https://chatgpt.com/backend-api/codex/responses',
  openaiApiBaseUrl: 'https://api.openai.com/v1',
  openaiApiResponsesUrl: '',
  openaiApiChatCompletionsUrl: '',
  openaiApiUpstream: 'official',
  defaultModel: 'gpt-5.6-sol',
  relays: [],
  chatgptAccounts: [],
  activeChatgptAccountId: null,
  chatgptAccountStrategy: 'headroom',
  chatgptLowQuotaThreshold: 10,
  crossProviderFallbackEnabled: false,
  fallbackChain: [
    { provider: 'chatgpt-sub', model: 'gpt-5.6-sol' },
    { provider: 'openai-api', model: 'openai-api-gpt-5.6-sol' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' }
  ],
  fallbackStatuses: [429, 502, 503, 504],
  providerBudgets: {}
}

export function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const text = JSON.stringify(value, null, 2)
  try {
    fs.writeFileSync(tempPath, text, { encoding: 'utf8', mode: 0o600 })
    const handle = fs.openSync(tempPath, 'r+')
    try {
      try { fs.fsyncSync(handle) } catch (error) {
        // Some Windows filesystems reject fsync even for a regular file.
        if (error.code !== 'EPERM' && error.code !== 'EINVAL') throw error
      }
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }) } catch {}
    throw error
  }
}

export async function atomicWriteJsonAsync(filePath, value) {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const text = JSON.stringify(value, null, 2)
  try {
    await fs.promises.writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(tempPath, filePath)
  } catch (error) {
    try { await fs.promises.rm(tempPath, { force: true }) } catch {}
    throw error
  }
}

function readStoredJson(filePath) {
  return decryptConfigSecrets(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

function writeCredentialJson(filePath, value) {
  atomicWriteJson(filePath, credentialStoreEnabled() ? encryptConfigSecrets(value) : value)
}

function writeCredentialBackupJson(filePath, value) {
  const stored = credentialStoreEnabled() ? encryptConfigSecrets(value) : value
  assertNoSecrets(stored, {
    source: `account-backup:${path.basename(filePath)}`,
    allowProtectedValues: true,
    message: 'Account backup requires encrypted credentials'
  })
  atomicWriteJson(filePath, stored)
}

function loadProxyConfig() {
  let fileCfg = {}
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = decryptConfigSecrets(JSON.parse(raw))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const migration = migrateConfigDocument(parsed)
      fileCfg = migration.document
      if (migration.changed) {
        backupBeforeMigration(CONFIG_FILE, raw, migration)
        writeCredentialJson(CONFIG_FILE, fileCfg)
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error.code === 'SECRET_SCAN_FAILED') {
        if (!warnedDeferredCredentialMigration) {
          warnedDeferredCredentialMigration = true
          console.warn(
            '[codex-proxy] config migration deferred until credentials are protected:',
            safeErrorText(error)
          )
        }
      } else {
        console.error('[codex-proxy] failed to load config:', safeErrorText(error))
      }
    }
  }

  const base = (process.env.CODEX_OPENAI_API_BASE_URL || process.env.OPENAI_BASE_URL || fileCfg.openai_api_base_url || CONFIG_DEFAULTS.openaiApiBaseUrl).replace(/\/+$/, '')

  // Parse relays: supports both file config and env var JSON
  let relays = fileCfg.relays || CONFIG_DEFAULTS.relays
  if (process.env.CODEX_RELAYS) {
    try { relays = JSON.parse(process.env.CODEX_RELAYS) } catch {}
  }

  const chatgptAccounts = fileCfg.chatgpt_accounts || CONFIG_DEFAULTS.chatgptAccounts

  return {
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || fileCfg.deepseek_api_key || CONFIG_DEFAULTS.deepseekApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || fileCfg.openai_api_key || CONFIG_DEFAULTS.openaiApiKey,
    openaiOrgId: process.env.OPENAI_ORG_ID || fileCfg.openai_org_id || CONFIG_DEFAULTS.openaiOrgId,
    openaiProjectId: process.env.OPENAI_PROJECT_ID || fileCfg.openai_project_id || CONFIG_DEFAULTS.openaiProjectId,
    upstreamUrl: process.env.DEEPSEEK_ANTHROPIC_URL || fileCfg.upstream_url || CONFIG_DEFAULTS.upstreamUrl,
    chatgptResponsesUrl: process.env.CODEX_CHATGPT_RESPONSES_URL || fileCfg.chatgpt_responses_url || CONFIG_DEFAULTS.chatgptResponsesUrl,
    openaiApiBaseUrl: base,
    openaiApiResponsesUrl: process.env.CODEX_OPENAI_API_RESPONSES_URL || fileCfg.openai_api_responses_url || base + '/responses',
    openaiApiChatCompletionsUrl: process.env.CODEX_OPENAI_API_CHAT_COMPLETIONS_URL || fileCfg.openai_api_chat_completions_url || base + '/chat/completions',
    openaiApiUpstream: process.env.CODEX_OPENAI_API_UPSTREAM || fileCfg.openai_api_upstream || CONFIG_DEFAULTS.openaiApiUpstream,
    defaultModel: process.env.CODEX_PROXY_DEFAULT_MODEL || fileCfg.default_model || CONFIG_DEFAULTS.defaultModel,
    relays,
    chatgptAccounts,
    activeChatgptAccountId: fileCfg.active_chatgpt_account_id || CONFIG_DEFAULTS.activeChatgptAccountId,
    chatgptAccountStrategy: ACCOUNT_STRATEGIES.has(fileCfg.chatgpt_account_strategy)
      ? fileCfg.chatgpt_account_strategy
      : CONFIG_DEFAULTS.chatgptAccountStrategy,
    chatgptLowQuotaThreshold: Number.isFinite(Number(fileCfg.chatgpt_low_quota_threshold))
      ? Math.max(0, Math.min(100, Number(fileCfg.chatgpt_low_quota_threshold)))
      : CONFIG_DEFAULTS.chatgptLowQuotaThreshold,
    crossProviderFallbackEnabled: fileCfg.cross_provider_fallback_enabled === true,
    fallbackChain: Array.isArray(fileCfg.fallback_chain)
      ? fileCfg.fallback_chain
      : CONFIG_DEFAULTS.fallbackChain,
    fallbackStatuses: Array.isArray(fileCfg.fallback_statuses)
      ? fileCfg.fallback_statuses.map(Number).filter(code => code >= 400 && code <= 599)
      : CONFIG_DEFAULTS.fallbackStatuses,
    providerBudgets: fileCfg.provider_budgets && typeof fileCfg.provider_budgets === 'object'
      ? fileCfg.provider_budgets
      : CONFIG_DEFAULTS.providerBudgets
  }
}

const SNAPSHOT_SENSITIVE_KEYS = new Set([
  'deepseek_api_key',
  'openai_api_key',
  'chatgpt_accounts',
  'active_chatgpt_account_id'
])

export function configForSettingsSnapshot(config) {
  const snapshot = structuredClone(config || {})
  for (const key of SNAPSHOT_SENSITIVE_KEYS) delete snapshot[key]
  snapshot.relays = (snapshot.relays || []).map(({ api_key, ...relay }) => relay)
  snapshot._snapshot = {
    version: 2,
    scope: 'settings-only',
    note: 'Credentials and ChatGPT accounts are intentionally excluded.'
  }
  return snapshot
}

export function mergeSettingsSnapshot(snapshot, current) {
  const safeSnapshot = structuredClone(snapshot || {})
  for (const key of SNAPSHOT_SENSITIVE_KEYS) delete safeSnapshot[key]
  delete safeSnapshot._snapshot
  const currentConfig = structuredClone(current || {})
  const currentRelayKeys = new Map(
    (currentConfig.relays || []).map(relay => [relay.id, relay.api_key || ''])
  )
  if (Array.isArray(safeSnapshot.relays)) {
    safeSnapshot.relays = safeSnapshot.relays.map(({ api_key, ...relay }) => ({
      ...relay,
      api_key: currentRelayKeys.get(relay.id) || ''
    }))
  }
  return {
    ...currentConfig,
    ...safeSnapshot,
    deepseek_api_key: currentConfig.deepseek_api_key || '',
    openai_api_key: currentConfig.openai_api_key || '',
    chatgpt_accounts: currentConfig.chatgpt_accounts || [],
    active_chatgpt_account_id: currentConfig.active_chatgpt_account_id || null
  }
}

function pruneJsonBackups(directory, keep = 10) {
  const snapshots = fs.readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()
  for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    try { fs.rmSync(path.join(directory, stale), { force: true }) } catch {}
  }
}

function createConfigSnapshot(reason = 'change') {
  if (!fs.existsSync(CONFIG_FILE)) return null
  fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeReason = String(reason).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'change'
  const file = path.join(CONFIG_BACKUP_DIR, `${stamp}-${safeReason}.json`)
  const current = readStoredJson(CONFIG_FILE)
  const snapshot = configForSettingsSnapshot(current)
  assertNoSecrets(snapshot, {
    source: `settings-backup:${path.basename(file)}`,
    message: 'Settings backup contains a secret'
  })
  atomicWriteJson(file, snapshot)
  try { fs.chmodSync(file, 0o600) } catch {}
  pruneJsonBackups(CONFIG_BACKUP_DIR)
  return file
}

export function createAccountBackup(reason = 'change') {
  if (!fs.existsSync(CONFIG_FILE)) return null
  const current = readStoredJson(CONFIG_FILE)
  fs.mkdirSync(ACCOUNT_BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeReason = String(reason).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'change'
  const file = path.join(ACCOUNT_BACKUP_DIR, `${stamp}-${safeReason}.json`)
  writeCredentialBackupJson(file, {
    version: 1,
    created_at: new Date().toISOString(),
    chatgpt_accounts: current.chatgpt_accounts || [],
    active_chatgpt_account_id: current.active_chatgpt_account_id || null
  })
  try { fs.chmodSync(file, 0o600) } catch {}
  pruneJsonBackups(ACCOUNT_BACKUP_DIR)
  return file
}

function accountBackupData(parsed) {
  const accounts = parsed?.chatgpt_accounts
  if (!Array.isArray(accounts)) throw new Error('账号备份中没有有效的账号列表')
  return {
    accounts,
    activeAccountId: parsed.active_chatgpt_account_id || null,
    createdAt: parsed.created_at || null
  }
}

export function mergeAccountBackup(currentAccounts, backupAccounts) {
  const currentByIdentity = new Map(
    (currentAccounts || []).map(account => [account.account_id || account.id, account])
  )
  const restored = [...(currentAccounts || [])]
  for (const backupAccount of (backupAccounts || [])) {
    const identity = backupAccount.account_id || backupAccount.id
    if (!identity || currentByIdentity.has(identity)) continue
    restored.push(backupAccount)
    currentByIdentity.set(identity, backupAccount)
  }
  return restored
}

export function listAccountBackups() {
  try {
    return fs.readdirSync(ACCOUNT_BACKUP_DIR)
      .filter(name => name.endsWith('.json'))
      .sort()
      .reverse()
      .map(name => {
        const file = path.join(ACCOUNT_BACKUP_DIR, name)
        const stat = fs.statSync(file)
        let accountCount = null
        try {
          accountCount = accountBackupData(readStoredJson(file)).accounts.length
        } catch {}
        return { name, created_at: stat.mtime.toISOString(), size: stat.size, account_count: accountCount }
      })
  } catch {
    return []
  }
}

export function restoreAccountBackup(name) {
  const safeName = path.basename(String(name || ''))
  if (!safeName || safeName !== name || !safeName.endsWith('.json')) throw new Error('Invalid account backup name')
  const parsed = readStoredJson(path.join(ACCOUNT_BACKUP_DIR, safeName))
  const backup = accountBackupData(parsed)
  const accounts = mergeAccountBackup(proxyConfig.chatgptAccounts || [], backup.accounts)
  const restoredCount = accounts.length - (proxyConfig.chatgptAccounts || []).length
  createAccountBackup('before-account-restore')
  const activeChatgptAccountId = proxyConfig.activeChatgptAccountId ||
    (accounts.some(account => account.id === backup.activeAccountId) ? backup.activeAccountId : null)
  const config = saveProxyConfig({ chatgptAccounts: accounts, activeChatgptAccountId })
  reloadProxyConfig()
  return { config, restoredCount }
}

export function listConfigSnapshots() {
  try {
    return fs.readdirSync(CONFIG_BACKUP_DIR)
      .filter(name => name.endsWith('.json'))
      .sort()
      .reverse()
      .map(name => {
        const stat = fs.statSync(path.join(CONFIG_BACKUP_DIR, name))
        return { name, created_at: stat.mtime.toISOString(), size: stat.size }
      })
  } catch {
    return []
  }
}

function sanitizeExistingConfigSnapshots() {
  try {
    for (const name of fs.readdirSync(CONFIG_BACKUP_DIR).filter(item => item.endsWith('.json'))) {
      try {
        const file = path.join(CONFIG_BACKUP_DIR, name)
        const parsed = readStoredJson(file)
        if (parsed?._snapshot?.scope === 'settings-only') continue
        const snapshot = configForSettingsSnapshot(parsed)
        assertNoSecrets(snapshot, {
          source: `existing-settings-backup:${name}`,
          message: 'Existing settings backup contains a secret'
        })
        atomicWriteJson(file, snapshot)
        try { fs.chmodSync(file, 0o600) } catch {}
      } catch (error) {
        console.error(
          '[codex-proxy] failed to sanitize config snapshot %s: %s',
          name,
          safeErrorText(error)
        )
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(
        '[codex-proxy] failed to sanitize an existing config snapshot:',
        safeErrorText(error)
      )
    }
  }
}

export function restoreConfigSnapshot(name) {
  const safeName = path.basename(String(name || ''))
  if (!safeName || safeName !== name || !safeName.endsWith('.json')) throw new Error('Invalid snapshot name')
  const source = path.join(CONFIG_BACKUP_DIR, safeName)
  const parsed = readStoredJson(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Snapshot is invalid')
  assertNoSecrets(parsed, {
    source: `settings-restore:${safeName}`,
    message: 'Settings backup contains a secret'
  })
  const current = readStoredJson(CONFIG_FILE)
  createConfigSnapshot('before-rollback')
  createAccountBackup('before-settings-rollback')
  writeCredentialJson(CONFIG_FILE, mergeSettingsSnapshot(parsed, current))
  return reloadProxyConfig()
}

function saveProxyConfig(fields, { snapshot = false, reason = 'change' } = {}) {
  let existing = {}
  try {
    existing = readStoredJson(CONFIG_FILE)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {}

  const map = {
    schema_version: fields.schemaVersion,
    deepseek_api_key: fields.deepseekApiKey,
    openai_api_key: fields.openaiApiKey,
    openai_org_id: fields.openaiOrgId,
    openai_project_id: fields.openaiProjectId,
    upstream_url: fields.upstreamUrl,
    chatgpt_responses_url: fields.chatgptResponsesUrl,
    openai_api_base_url: fields.openaiApiBaseUrl,
    openai_api_responses_url: fields.openaiApiResponsesUrl,
    openai_api_chat_completions_url: fields.openaiApiChatCompletionsUrl,
    openai_api_upstream: fields.openaiApiUpstream,
    default_model: fields.defaultModel,
    chatgpt_account_strategy: fields.chatgptAccountStrategy,
    chatgpt_low_quota_threshold: fields.chatgptLowQuotaThreshold,
    cross_provider_fallback_enabled: fields.crossProviderFallbackEnabled,
    fallback_chain: fields.fallbackChain,
    fallback_statuses: fields.fallbackStatuses,
    provider_budgets: fields.providerBudgets
  }
  existing.schema_version ||= migrateConfigDocument(existing).to

  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) existing[k] = v
  }

  // Persist relays if provided
  if (fields.relays !== undefined) {
    existing.relays = fields.relays
  }

  // Persist chatgpt accounts if provided
  if (fields.chatgptAccounts !== undefined) {
    existing.chatgpt_accounts = fields.chatgptAccounts
  }

  if (fields.activeChatgptAccountId !== undefined) {
    existing.active_chatgpt_account_id = fields.activeChatgptAccountId
  }

  if (snapshot) createConfigSnapshot(reason)
  writeCredentialJson(CONFIG_FILE, existing)
  return loadProxyConfig()
}

sanitizeExistingConfigSnapshots()
let proxyConfig = loadProxyConfig()

function reloadProxyConfig() {
  proxyConfig = loadProxyConfig()
  console.log('[codex-proxy] 配置已热重载')
  return proxyConfig
}

export function initializeCredentialProtection() {
  credentialProtection = initializeCredentialStore(STORAGE_ROOT)
  if (!credentialProtection.enabled) return credentialProtection
  let migratedFiles = 0
  const migrate = file => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const encrypted = encryptConfigSecrets(decryptConfigSecrets(raw))
    if (JSON.stringify(raw) === JSON.stringify(encrypted)) return
    atomicWriteJson(file, encrypted)
    try { fs.chmodSync(file, 0o600) } catch {}
    migratedFiles++
  }
  if (fs.existsSync(CONFIG_FILE)) migrate(CONFIG_FILE)
  for (const directory of [ACCOUNT_BACKUP_DIR, MIGRATION_BACKUP_DIR]) {
    try {
      for (const name of fs.readdirSync(directory).filter(item =>
        item.endsWith('.json') || item.endsWith('.bak')
      )) {
        migrate(path.join(directory, name))
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  reloadProxyConfig()
  return { ...credentialProtection, migratedFiles }
}

export function getCredentialProtectionStatus() {
  return {
    enabled: credentialStoreEnabled(),
    protection: credentialStoreEnabled() ? 'Windows DPAPI + AES-256-GCM' : null,
    reason: credentialStoreEnabled() ? null : credentialProtection.reason
  }
}

// Relay helpers
export function getRelay(relayId) {
  return (proxyConfig.relays || []).find(r => r.id === relayId)
}

export function addRelay(relay) {
  const relays = [...(proxyConfig.relays || [])]
  const idx = relays.findIndex(r => r.id === relay.id)
  if (idx >= 0) relays[idx] = relay
  else relays.push(relay)
  const newCfg = saveProxyConfig({ relays }, { snapshot: true, reason: 'relay-save' })
  reloadProxyConfig()
  return newCfg
}

export function deleteRelay(relayId) {
  const relays = (proxyConfig.relays || []).filter(r => r.id !== relayId)
  const newCfg = saveProxyConfig({ relays }, { snapshot: true, reason: 'relay-delete' })
  reloadProxyConfig()
  return newCfg
}

// ChatGPT account pool helpers
export function upsertChatgptAccount(account) {
  const accounts = [...(proxyConfig.chatgptAccounts || [])]
  const idx = accounts.findIndex(a => a.id === account.id)
  if (idx >= 0) accounts[idx] = account
  else accounts.push(account)
  const newCfg = saveProxyConfig(
    { chatgptAccounts: accounts },
    idx < 0 ? { snapshot: true, reason: 'account-add' } : undefined
  )
  proxyConfig = newCfg
  return newCfg
}

export function patchChatgptAccounts(updates, { onlyExisting = true } = {}) {
  if (!Array.isArray(updates)) throw new Error('Account updates must be an array')
  const pending = new Map()
  for (const update of updates) {
    const accountId = String(update?.id || '').trim()
    if (!accountId) throw new Error('Account update requires an id')
    const patch = update?.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`Account update ${accountId} requires an object patch`)
    }
    pending.set(accountId, { ...(pending.get(accountId) || {}), ...patch })
  }
  if (!pending.size) return proxyConfig

  let changed = false
  const accounts = (proxyConfig.chatgptAccounts || []).map(account => {
    const patch = pending.get(account.id)
    if (!patch) return account
    pending.delete(account.id)
    changed = true
    return { ...account, ...structuredClone(patch) }
  })
  if (!onlyExisting) {
    for (const [accountId, patch] of pending) {
      changed = true
      accounts.push({ id: accountId, ...structuredClone(patch) })
    }
  }
  if (!changed) return proxyConfig

  proxyConfig = saveProxyConfig({ chatgptAccounts: accounts })
  return proxyConfig
}

export function deleteChatgptAccount(accountId) {
  createAccountBackup('before-account-delete')
  const accounts = (proxyConfig.chatgptAccounts || []).filter(a => a.id !== accountId)
  const fields = { chatgptAccounts: accounts }
  if (proxyConfig.activeChatgptAccountId === accountId) fields.activeChatgptAccountId = null
  const newCfg = saveProxyConfig(fields, { snapshot: true, reason: 'account-delete' })
  reloadProxyConfig()
  return newCfg
}

export function setActiveChatgptAccount(accountId) {
  const newCfg = saveProxyConfig({ activeChatgptAccountId: accountId }, { snapshot: true, reason: 'account-switch' })
  reloadProxyConfig()
  return newCfg
}

export function orderChatgptAccounts(accounts, accountIds) {
  if (!Array.isArray(accountIds)) throw new Error('accountIds must be an array')
  const byId = new Map(accounts.map(account => [account.id, account]))
  const uniqueIds = [...new Set(accountIds)]
  if (uniqueIds.length !== accounts.length || uniqueIds.some(accountId => !byId.has(accountId))) {
    throw new Error('Account order must contain every account exactly once')
  }
  return uniqueIds.map(accountId => byId.get(accountId))
}

export function reorderChatgptAccounts(accountIds) {
  const reordered = orderChatgptAccounts(proxyConfig.chatgptAccounts || [], accountIds)
  const newCfg = saveProxyConfig({ chatgptAccounts: reordered }, { snapshot: true, reason: 'account-reorder' })
  reloadProxyConfig()
  return newCfg
}

export function renameChatgptAccountInList(accounts, accountId, label) {
  const normalized = String(label || '').trim()
  if (!normalized) throw new Error('账号名称不能为空')
  if (normalized.length > 80) throw new Error('账号名称不能超过 80 个字符')
  let found = false
  const renamed = accounts.map(account => {
    if (account.id !== accountId) return account
    found = true
    return { ...account, label: normalized }
  })
  if (!found) throw new Error('Account not found')
  return renamed
}

export function renameChatgptAccount(accountId, label) {
  const accounts = renameChatgptAccountInList(proxyConfig.chatgptAccounts || [], accountId, label)
  const newCfg = saveProxyConfig({ chatgptAccounts: accounts }, { snapshot: true, reason: 'account-rename' })
  reloadProxyConfig()
  return newCfg
}

export function setChatgptAccountRouting(accountId, {
  weight,
  enabled,
  poolTier,
  lowQuotaThreshold,
  dailyRequestLimit,
  dailyTokenLimit,
  concurrencyLimit,
  adaptiveConcurrencyEnabled,
  reservedModels,
  reservedSessionIds,
  emergencyContinueMinutes,
  confirmedEmergencyRisk
} = {}) {
  const accounts = (proxyConfig.chatgptAccounts || []).map(account => {
    if (account.id !== accountId) return account
    const emergencyMinutes = Number(emergencyContinueMinutes)
    if (emergencyMinutes > 0 && confirmedEmergencyRisk !== true) {
      throw new Error('Emergency continuation requires explicit risk confirmation')
    }
    const normalizeList = value => Array.isArray(value)
      ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 50)
      : undefined
    const currentTier = account.pool_tier ||
      (account.credential_mode === 'temporary_access' ? 'disposable' : 'stable')
    const requestedTier = poolTier === undefined ? null : String(poolTier).trim().toLowerCase()
    if (requestedTier !== null && !['stable', 'disposable'].includes(requestedTier)) {
      throw new Error('Account pool tier must be stable or disposable')
    }
    if (
      concurrencyLimit !== undefined &&
      (
        typeof concurrencyLimit !== 'number' ||
        !Number.isInteger(concurrencyLimit) ||
        concurrencyLimit < 1 ||
        concurrencyLimit > 20
      )
    ) {
      throw new Error('Account concurrency limit must be an integer between 1 and 20')
    }
    if (
      adaptiveConcurrencyEnabled !== undefined &&
      typeof adaptiveConcurrencyEnabled !== 'boolean'
    ) {
      throw new Error('Adaptive concurrency flag must be boolean')
    }
    const tierChanged = requestedTier !== null && requestedTier !== currentTier
    const tierFields = requestedTier === null
      ? {}
      : {
          pool_tier: requestedTier,
          ...(tierChanged ? { pool_tier_assigned_at: new Date().toISOString() } : {}),
          ...(tierChanged || requestedTier === 'stable'
            ? {
                disposable_exhausted_at: null,
                disposable_discarded_at: null,
                disposable_last_reset_at: null,
                discard_reason: null
              }
            : {}),
          ...(tierChanged && account.status === 'discarded'
            ? { status: 'active', auth_error: null }
            : {})
        }
    return {
      ...account,
      ...tierFields,
      ...(weight === undefined
        ? {}
        : { routing_weight: Math.max(1, Math.min(100, Number(weight) || 1)) }),
      ...(enabled === undefined ? {} : { routing_enabled: Boolean(enabled) }),
      ...(lowQuotaThreshold === undefined ? {} : {
        low_quota_threshold: Math.max(0, Math.min(100, Number(lowQuotaThreshold) || 0))
      }),
      ...(dailyRequestLimit === undefined ? {} : {
        daily_request_limit: Math.max(0, Math.floor(Number(dailyRequestLimit) || 0))
      }),
      ...(dailyTokenLimit === undefined ? {} : {
        daily_token_limit: Math.max(0, Math.floor(Number(dailyTokenLimit) || 0))
      }),
      ...(concurrencyLimit === undefined ? {} : {
        concurrency_limit: Number(concurrencyLimit)
      }),
      ...(adaptiveConcurrencyEnabled === undefined ? {} : {
        adaptive_concurrency_enabled: Boolean(adaptiveConcurrencyEnabled)
      }),
      ...(reservedModels === undefined ? {} : { reserved_models: normalizeList(reservedModels) }),
      ...(reservedSessionIds === undefined ? {} : { reserved_session_ids: normalizeList(reservedSessionIds) }),
      ...(emergencyContinueMinutes === undefined ? {} : {
        emergency_continue_until: emergencyMinutes > 0
          ? new Date(Date.now() + Math.min(24 * 60, emergencyMinutes) * 60_000).toISOString()
          : null
      })
    }
  })
  if (!accounts.some(account => account.id === accountId)) throw new Error('Account not found')
  const newCfg = saveProxyConfig({ chatgptAccounts: accounts }, { snapshot: true, reason: 'account-routing' })
  reloadProxyConfig()
  return newCfg
}

export function setChatgptAccountRoutingWeight(accountId, weight) {
  return setChatgptAccountRouting(accountId, { weight })
}

export {
  proxyConfig,
  reloadProxyConfig,
  saveProxyConfig,
  CONFIG_FILE,
  PROXY_DIR,
  STORAGE_ROOT,
  loadProxyConfig
}
