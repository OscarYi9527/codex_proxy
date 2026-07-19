import { proxyConfig } from './config.js'
import { accountActiveRequestCount, accountConcurrencyLimit, accountCredentialLifecycle, accountPolicyState, accountRemainingPercent } from './chatgpt-accounts.js'
import { getCircuitStates } from './circuit-breaker.js'
import { getHttpErrorGuide } from './error-guide.js'
import { getProviderHealth } from './provider-health.js'
import { getStats } from './stats.js'

function action(id, label, target, description) {
  return { id, label, target, description }
}

function addIssue(issues, {
  id,
  level = 'warning',
  title,
  conclusion,
  count = null,
  actions = []
}) {
  issues.push({ id, level, title, conclusion, count, actions })
}

export function accountPoolDiagnosis({ model = null, now = Date.now() } = {}) {
  const accounts = proxyConfig.chatgptAccounts || []
  const stats = getStats()
  const threshold = Number(proxyConfig.chatgptLowQuotaThreshold ?? 10)
  const counts = {
    total: accounts.length,
    temporary: 0,
    incompatible: 0,
    expiring_soon: 0,
    temporary_expired: 0,
    stored_only: 0,
    auth_error: 0,
    cooling: 0,
    model_cooling: 0,
    below_reserve: 0,
    daily_limited: 0,
    reserved_for_other_work: 0,
    busy: 0,
    emergency_continue: 0,
    eligible: 0
  }
  let earliestRecoveryAt = null
  for (const account of accounts) {
    const credential = accountCredentialLifecycle(account, now)
    if (credential.temporary) counts.temporary++
    if (!credential.compatible) counts.incompatible++
    if (credential.expiring_soon) counts.expiring_soon++
    if (credential.expired) counts.temporary_expired++
    if (account.routing_enabled === false) {
      counts.stored_only++
      continue
    }
    if (account.status === 'auth_error') {
      counts.auth_error++
      continue
    }
    if (account.status === 'cooldown' && Number(account.cooldown_until) > now) {
      counts.cooling++
      earliestRecoveryAt = earliestRecoveryAt
        ? Math.min(earliestRecoveryAt, Number(account.cooldown_until))
        : Number(account.cooldown_until)
      continue
    }
    if (model && Number(account.model_cooldowns?.[model]) > now) {
      counts.model_cooling++
      earliestRecoveryAt = earliestRecoveryAt
        ? Math.min(earliestRecoveryAt, Number(account.model_cooldowns[model]))
        : Number(account.model_cooldowns[model])
      continue
    }
    const policy = accountPolicyState(account, { model, globalReserve: threshold, now, statsSnapshot: stats })
    const remaining = accountRemainingPercent(account)
    if (!policy.emergency && (policy.request_limited || policy.token_limited)) counts.daily_limited++
    else if (!policy.emergency && policy.reservation_blocked) counts.reserved_for_other_work++
    else if (!policy.emergency && remaining !== null && remaining <= policy.reserve) counts.below_reserve++
    else if (accountActiveRequestCount(account.id) >= accountConcurrencyLimit(account.id)) counts.busy++
    else {
      if (policy.emergency) counts.emergency_continue++
      counts.eligible++
    }
  }
  return {
    ...counts,
    earliest_recovery_at: earliestRecoveryAt ? new Date(earliestRecoveryAt).toISOString() : null
  }
}

export function buildAutomaticDiagnosis({
  status = null,
  errorType = '',
  provider = '',
  model = null,
  details = null
} = {}) {
  const numericStatus = Number(status) || null
  const pool = { ...accountPoolDiagnosis({ model }), ...(details && typeof details === 'object' ? details : {}) }
  const providerHealth = getProviderHealth()
  const circuits = getCircuitStates()
  const stats = getStats()
  const issues = []

  if (pool.stored_only > 0) addIssue(issues, {
    id: 'stored_only',
    title: `${pool.stored_only} 个账号仅保存`,
    conclusion: '这些账号不会参与代理路由；只有确认需要使用时才启用。',
    count: pool.stored_only,
    actions: [action('open_accounts', '查看账号池', '#accounts', '检查并按需启用路由')]
  })
  if (pool.auth_error > 0) addIssue(issues, {
    id: 'auth_error',
    level: 'critical',
    title: `${pool.auth_error} 个账号登录失效`,
    conclusion: 'Access Token 或 Refresh Token 已不可用，需要重新完成官方登录。',
    count: pool.auth_error,
    actions: [action('official_login', '重新登录', '#accounts', '启动官方隔离登录预检')]
  })
  if (pool.expiring_soon > 0) addIssue(issues, {
    id: 'temporary_expiring',
    title: `${pool.expiring_soon} 个临时账号将在 24 小时内到期`,
    conclusion: '这些账号没有 ChatGPT Refresh Token；到期后会自动停止路由，不能自动续约。',
    count: pool.expiring_soon,
    actions: [action('open_accounts', '查看倒计时', '#accounts', '按“24h 内到期”分类查看账号')]
  })
  if (pool.incompatible > 0) addIssue(issues, {
    id: 'temporary_incompatible',
    level: 'critical',
    title: `${pool.incompatible} 个临时账号 OAuth 权限不兼容`,
    conclusion: 'Token 可以查询部分账号信息，但不是 Codex 官方 OAuth 客户端签发，不能调用订阅 Responses。',
    count: pool.incompatible,
    actions: [action('official_login', '批量官方登录', '#accounts', '用官方 OAuth 将临时账号升级为可续约账号')]
  })
  if (pool.below_reserve > 0) addIssue(issues, {
    id: 'below_reserve',
    title: `${pool.below_reserve} 个账号达到安全余量`,
    conclusion: '系统正在保护剩余额度；刷新后仍低于账号阈值时会继续暂停。',
    count: pool.below_reserve,
    actions: [action('refresh_quota', '刷新额度', '/admin/api/chatgpt-accounts/refresh-all', '重新查询全部已启用账号额度')]
  })
  if (pool.daily_limited > 0) addIssue(issues, {
    id: 'daily_limited',
    title: `${pool.daily_limited} 个账号达到每日上限`,
    conclusion: '请求数或 Token 已达到账号策略上限，将在北京时间次日自动恢复。',
    count: pool.daily_limited,
    actions: [action('open_account_policy', '检查额度策略', '#accounts', '查看每日请求和 Token 上限')]
  })
  const cooling = Number(pool.cooling || 0) + Number(pool.model_cooling || 0)
  if (cooling > 0) addIssue(issues, {
    id: 'cooling',
    title: `${cooling} 个账号或模型正在冷却`,
    conclusion: pool.earliest_recovery_at
      ? `最早预计在 ${new Date(pool.earliest_recovery_at).toLocaleString('zh-CN')} 恢复，请不要连续重试。`
      : '等待 Retry-After 或冷却时间结束后系统会自动恢复。',
    count: cooling,
    actions: [action('wait_cooldown', '等待冷却', '#accounts', '查看预计恢复时间')]
  })
  if (pool.busy > 0) addIssue(issues, {
    id: 'busy',
    title: `${pool.busy} 个账号并发已满`,
    conclusion: '当前请求会进入本地公平队列；等待正在运行的请求结束。',
    count: pool.busy,
    actions: [action('view_queue', '查看队列', '#settings', '检查活动请求和排队深度')]
  })
  if (pool.reserved_for_other_work > 0) addIssue(issues, {
    id: 'reserved',
    title: `${pool.reserved_for_other_work} 个账号已预留`,
    conclusion: '当前模型或会话不符合专用预留规则。',
    count: pool.reserved_for_other_work,
    actions: [action('open_account_policy', '检查预留规则', '#accounts', '查看模型和会话预留')]
  })

  const unhealthyProviders = Object.entries(providerHealth.providers || {})
    .filter(([, value]) => ['unhealthy', 'auth_error', 'degraded'].includes(value.state))
  if (unhealthyProviders.length) addIssue(issues, {
    id: 'provider_health',
    level: unhealthyProviders.some(([, value]) => ['unhealthy', 'auth_error'].includes(value.state)) ? 'critical' : 'warning',
    title: `${unhealthyProviders.length} 个 Provider 状态异常`,
    conclusion: unhealthyProviders.map(([name, value]) => `${name}: ${value.state}${value.last_status ? ` (HTTP ${value.last_status})` : ''}`).join('；'),
    count: unhealthyProviders.length,
    actions: [action('ping_providers', '检测 Provider', '#providers', '重新执行全部通道连通性检测')]
  })
  const openCircuits = circuits.filter(item => item.state !== 'closed')
  if (openCircuits.length) addIssue(issues, {
    id: 'circuit_open',
    level: 'critical',
    title: `${openCircuits.length} 个 Provider 熔断`,
    conclusion: '网络错误、408 或 5xx 连续发生；系统会在恢复窗口进入半开探测。',
    count: openCircuits.length,
    actions: [action('view_circuits', '查看熔断状态', '#settings', '查看恢复倒计时和最近故障')]
  })

  if (numericStatus === 401 || numericStatus === 403) addIssue(issues, {
    id: 'request_auth',
    level: 'critical',
    title: `HTTP ${numericStatus} 鉴权或权限失败`,
    conclusion: provider ? `${provider} 的凭据或权限无效。` : '检查报错来源对应的账号登录或 API Key。',
    actions: [
      action('official_login', '重新登录', '#accounts', '用于 ChatGPT 订阅账号'),
      action('open_providers', '检查 API Key', '#providers', '用于 API 或中转线路')
    ]
  })
  if (numericStatus === 402) addIssue(issues, {
    id: 'billing',
    level: 'critical',
    title: 'HTTP 402 余额或套餐不可用',
    conclusion: 'ChatGPT 订阅和 API 余额相互独立；请到报错 Provider 检查余额、账单与模型权益。',
    actions: [action('open_providers', '检查 Provider', '#providers', '确认报错线路及计费配置')]
  })
  if (numericStatus === 429 && !issues.some(item => item.id === 'cooling')) addIssue(issues, {
    id: 'rate_limit',
    title: 'HTTP 429 请求频率或额度受限',
    conclusion: '停止立即重试，等待 Retry-After；系统会按模型或账号范围自动冷却。',
    actions: [action('wait_cooldown', '查看冷却', '#accounts', '检查模型和账号恢复时间')]
  })
  if ([502, 503, 504].includes(numericStatus) && !issues.some(item => item.id === 'provider_health')) addIssue(issues, {
    id: 'upstream_unavailable',
    level: 'critical',
    title: `HTTP ${numericStatus} 上游暂不可用`,
    conclusion: '若账号池仍有可用账号，优先检查 Provider 网络、Base URL、熔断与维护状态。',
    actions: [action('ping_providers', '检测 Provider', '#providers', '执行连通性检测')]
  })

  return {
    generated_at: new Date().toISOString(),
    request: { status: numericStatus, error_type: errorType || null, provider: provider || null, model },
    guide: numericStatus ? getHttpErrorGuide(numericStatus, errorType) : null,
    summary: {
      level: issues.some(item => item.level === 'critical') ? 'critical' : (issues.length ? 'warning' : 'healthy'),
      conclusion: issues.length
        ? `发现 ${issues.length} 项需要关注的问题。`
        : (pool.eligible > 0 ? `账号池有 ${pool.eligible} 个可用账号，未发现明显异常。` : '当前没有可用账号，但尚未识别到具体运行状态。')
    },
    account_pool: pool,
    provider_health: providerHealth,
    circuits,
    trends: {
      operational: stats.operational_windows || {},
      accounts: stats.accounts || {}
    },
    issues
  }
}
