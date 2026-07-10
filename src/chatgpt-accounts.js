// ChatGPT subscription account pool
// Holds credentials for one or more official ChatGPT accounts pasted in from
// `~/.codex/auth.json`, and rotates between them when the upstream reports
// the active account is rate-limited / over quota.

import { proxyConfig, upsertChatgptAccount as persistAccount, deleteChatgptAccount as removeAccount } from './config.js'
import { id } from './server-utils.js'

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REFRESH_SAFETY_MARGIN_MS = 30 * 1000
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000

function decodeJwtExpiry(token) {
  try {
    const payloadSegment = token.split('.')[1]
    const payload = JSON.parse(Buffer.from(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return payload.exp ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export function parseAuthJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('auth.json 内容不是合法的 JSON')
  }
  const tokens = parsed?.tokens
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('auth.json 缺少 tokens 字段')
  }
  const { access_token, refresh_token, id_token, account_id } = tokens
  if (!access_token || !refresh_token || !account_id) {
    throw new Error('auth.json 缺少 access_token / refresh_token / account_id')
  }
  return { access_token, refresh_token, id_token, account_id }
}

export function addChatgptAccount(raw, label) {
  const { access_token, refresh_token, id_token, account_id } = parseAuthJson(raw)
  const account = {
    id: id('acct'),
    label: label || account_id,
    access_token,
    refresh_token,
    id_token,
    account_id,
    expires_at: decodeJwtExpiry(access_token) || (Date.now() + 3600 * 1000),
    status: 'active',
    cooldown_until: null,
    last_refresh: new Date().toISOString()
  }
  return persistAccount(account)
}

export function deleteChatgptAccount(accountId) {
  return removeAccount(accountId)
}

// Finds the first non-cooldown account not in excludeIds, auto-restoring any
// account whose cooldown has already elapsed. Returns null if every account
// is either cooling down or already excluded (e.g. tried earlier in this request).
export function pickActiveAccount(excludeIds = null) {
  const accounts = proxyConfig.chatgptAccounts || []
  const now = Date.now()
  for (const account of accounts) {
    if (excludeIds && excludeIds.has(account.id)) continue
    if (account.status !== 'cooldown') return account
    if (account.cooldown_until && now > account.cooldown_until) {
      account.status = 'active'
      account.cooldown_until = null
      persistAccount(account)
      return account
    }
  }
  return null
}

export async function ensureFreshToken(account, fetchImpl = fetch) {
  if (account.expires_at && account.expires_at - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
    return account
  }
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token
    })
  })
  if (!response.ok) {
    throw new Error(`ChatGPT 账号 token 刷新失败 (status ${response.status})`)
  }
  const data = await response.json()
  account.access_token = data.access_token || account.access_token
  account.refresh_token = data.refresh_token || account.refresh_token
  account.id_token = data.id_token || account.id_token
  account.expires_at = decodeJwtExpiry(account.access_token) || (Date.now() + 3600 * 1000)
  account.last_refresh = new Date().toISOString()
  persistAccount(account)
  return account
}

// `response` should be an unconsumed clone (or a response whose body you no
// longer need) since this may read its body to look for a reset time.
export async function markAccountCooldown(accountId, response) {
  const accounts = proxyConfig.chatgptAccounts || []
  const account = accounts.find(a => a.id === accountId)
  if (!account) return

  let cooldownMs = DEFAULT_COOLDOWN_MS
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    cooldownMs = Number(retryAfter) * 1000
  } else if (response) {
    try {
      const text = await response.text()
      const match = text.match(/"resets?_(?:in|at)"\s*:\s*"?(\d+)/i)
      if (match) {
        const value = Number(match[1])
        if (Number.isFinite(value) && value > 0) {
          cooldownMs = value > 1e12 ? value - Date.now() : value * 1000
        }
      }
    } catch {}
  }

  account.status = 'cooldown'
  account.cooldown_until = Date.now() + Math.max(cooldownMs, 1000)
  persistAccount(account)
}
