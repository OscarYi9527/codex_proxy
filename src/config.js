import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PROXY_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(PROXY_DIR, '..', 'codex-proxy-config.json')

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
  defaultModel: 'deepseek-v4-pro',
  relays: [],
  chatgptAccounts: []
}

function loadProxyConfig() {
  let fileCfg = {}
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileCfg = parsed
  } catch {}

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
    chatgptAccounts
  }
}

function saveProxyConfig(fields) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch {}
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
    default_model: fields.defaultModel
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

  fs.mkdirSync(path.join(PROXY_DIR, '..'), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2))
  return loadProxyConfig()
}

let proxyConfig = loadProxyConfig()

function reloadProxyConfig() {
  proxyConfig = loadProxyConfig()
  console.log('[codex-proxy] 配置已热重载')
  return proxyConfig
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
  const newCfg = saveProxyConfig({ relays })
  reloadProxyConfig()
  return newCfg
}

export function deleteRelay(relayId) {
  const relays = (proxyConfig.relays || []).filter(r => r.id !== relayId)
  const newCfg = saveProxyConfig({ relays })
  reloadProxyConfig()
  return newCfg
}

// ChatGPT account pool helpers
export function upsertChatgptAccount(account) {
  const accounts = [...(proxyConfig.chatgptAccounts || [])]
  const idx = accounts.findIndex(a => a.id === account.id)
  if (idx >= 0) accounts[idx] = account
  else accounts.push(account)
  const newCfg = saveProxyConfig({ chatgptAccounts: accounts })
  reloadProxyConfig()
  return newCfg
}

export function deleteChatgptAccount(accountId) {
  const accounts = (proxyConfig.chatgptAccounts || []).filter(a => a.id !== accountId)
  const newCfg = saveProxyConfig({ chatgptAccounts: accounts })
  reloadProxyConfig()
  return newCfg
}

export { proxyConfig, reloadProxyConfig, saveProxyConfig, CONFIG_FILE, PROXY_DIR, loadProxyConfig }
