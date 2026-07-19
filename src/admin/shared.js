const CHATGPT_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

function accessTokenCompatibility(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token || '').split('.')[1], 'base64url').toString('utf8'))
    return payload.client_id === CHATGPT_CODEX_OAUTH_CLIENT_ID
      ? 'codex_subscription'
      : 'incompatible_oauth_client'
  } catch {
    return 'unknown_oauth_client'
  }
}

function maskChatgptAccounts(accounts) {
  if (!accounts) return accounts
  return accounts.map(({ access_token, refresh_token, id_token, ...account }) => {
    const masked = {
      ...account,
      credential_mode: account.credential_mode || (refresh_token ? 'refreshable' : 'temporary_access'),
      credential_compatibility: account.credential_compatibility || accessTokenCompatibility(access_token)
    }
    if (!masked.reset_credits) return masked
    const { available_count, total_earned_count, expires_at, updated_at } = account.reset_credits
    return { ...masked, reset_credits: { available_count, total_earned_count, expires_at, updated_at } }
  })
}

export function publicProxyConfig(config) {
  const masked = { ...config }
  for (const key of ['deepseekApiKey', 'openaiApiKey']) {
    if (masked[key] && masked[key].length > 4) masked[key] = masked[key].slice(0, 4) + '*'.repeat(masked[key].length - 4)
  }
  masked.relays = (masked.relays || []).map(relay => ({
    ...relay,
    api_key: relay.api_key && relay.api_key.length > 6 ? relay.api_key.slice(0, 6) + '***' : relay.api_key
  }))
  masked.chatgptAccounts = maskChatgptAccounts(masked.chatgptAccounts)
  return masked
}
