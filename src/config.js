import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { credentialStoreEnabled, decryptConfigSecrets, encryptConfigSecrets, initializeCredentialStore } from './credential-store.js'

const PROXY_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(PROXY_DIR, '..', 'codex-proxy-config.json')
const CONFIG_BACKUP_DIR = path.join(PROXY_DIR, '..', '.config-backups')
const ACCOUNT_BACKUP_DIR = path.join(PROXY_DIR, '..', '.account-backups')
let credentialProtection = { enabled: false, reason: 'not initialized' }

// A previously initialized install must decrypt before the first config load.
if (process.platform === 'win32' && fs.existsSync(path.join(PROXY_DIR, '..', '.credential-key.dpapi.json'))) {
  credentialProtection = initializeCredentialStore(path.join(PROXY_DIR, '..'))
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
  chatgptLowQuotaThreshold: 10
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

function readStoredJson(filePath) {
  return decryptConfigSecrets(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

function writeCredentialJson(filePath, value) {
  atomicWriteJson(filePath, credentialStoreEnabled() ? encryptConfigSecrets(value) : value)
}

function loadProxyConfig() {
  let fileCfg = {}
  try {
    const parsed = readStoredJson(CONFIG_FILE)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileCfg = parsed
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[codex-proxy] failed to load config:', error.message)
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
      : CONFIG_DEFAULTS.chatgptLowQuotaThreshold
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
  atomicWriteJson(file, configForSettingsSnapshot(current))
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
  writeCredentialJson(file, {
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
        atomicWriteJson(file, configForSettingsSnapshot(parsed))
        try { fs.chmodSync(file, 0o600) } catch {}
      } catch (error) {
        console.error('[codex-proxy] failed to sanitize config snapshot %s: %s', name, error.message)
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[codex-proxy] failed to sanitize an existing config snapshot:', error.message)
    }
  }
}

export function restoreConfigSnapshot(name) {
  const safeName = path.basename(String(name || ''))
  if (!safeName || safeName !== name || !safeName.endsWith('.json')) throw new Error('Invalid snapshot name')
  const source = path.join(CONFIG_BACKUP_DIR, safeName)
  const parsed = readStoredJson(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Snapshot is invalid')
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
    chatgpt_low_quota_threshold: fields.chatgptLowQuotaThreshold
  }

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
  credentialProtection = initializeCredentialStore(path.join(PROXY_DIR, '..'))
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
  try {
    for (const name of fs.readdirSync(ACCOUNT_BACKUP_DIR).filter(item => item.endsWith('.json'))) {
      migrate(path.join(ACCOUNT_BACKUP_DIR, name))
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
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
  reloadProxyConfig()
  return newCfg
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
  lowQuotaThreshold,
  dailyRequestLimit,
  dailyTokenLimit,
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
    return {
      ...account,
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

export { proxyConfig, reloadProxyConfig, saveProxyConfig, CONFIG_FILE, PROXY_DIR, loadProxyConfig }
