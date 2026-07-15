function maskChatgptAccounts(accounts) {
  if (!accounts) return accounts
  return accounts.map(({ access_token, refresh_token, id_token, ...account }) => {
    if (!account.reset_credits) return account
    const { available_count, total_earned_count, expires_at, updated_at } = account.reset_credits
    return { ...account, reset_credits: { available_count, total_earned_count, expires_at, updated_at } }
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
