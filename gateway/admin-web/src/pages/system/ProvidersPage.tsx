import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import { currentCodexAuthFromEvent } from '../../app/bootstrap'
import { CompactManagementPage } from '../compact/CompactManagementPage'
import type {
  AccountRoutingStrategy,
  ChatgptAccountLoginStatus,
  ModelRouteResponse,
  ProviderCredentialSummary,
  ProviderListResponse,
  ProviderQuotaWindow,
  ProviderSummary
} from '../../app/types'

const providerKindLabels: Record<ProviderSummary['kind'], string> = {
  chatgpt: 'ChatGPT 订阅（试验通道）',
  openai: 'OpenAI API',
  deepseek: 'DeepSeek',
  relay: 'Relay'
}

const strategyLabels: Record<AccountRoutingStrategy, string> = {
  priority: '按优先级',
  'round-robin': '轮询',
  headroom: '额度余量优先',
  'least-used': '最少使用',
  latency: '低延迟优先',
  reliable: '稳定性优先',
  weighted: '按权重',
  random: '随机',
  lkgp: '会话粘性'
}

function dateTime(value: string | number | null): string {
  if (value === null || value === '') return '—'
  const date = typeof value === 'number'
    ? new Date(value < 10_000_000_000 ? value * 1000 : value)
    : new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('zh-CN', { hour12: false })
}

function statusLabel(status: string, routingEnabled: boolean): {
  label: string
  tone: 'healthy' | 'warning' | 'danger' | 'muted'
} {
  if (!routingEnabled) return { label: '仅保存', tone: 'muted' }
  if (status === 'active') return { label: '参与路由', tone: 'healthy' }
  if (status === 'healthy') return { label: '健康', tone: 'healthy' }
  if (status === 'degraded') return { label: '性能下降', tone: 'warning' }
  if (status === 'unhealthy') return { label: '上游异常', tone: 'danger' }
  if (status === 'circuit_open') return { label: '熔断中', tone: 'danger' }
  if (status === 'cooldown') return { label: '冷却中', tone: 'warning' }
  if (status === 'auth_error') return { label: '登录失效', tone: 'danger' }
  if (status === 'disabled') return { label: '已停用', tone: 'muted' }
  return { label: status === 'unknown' ? '等待检测' : status, tone: 'warning' }
}

function credentialLabel(
  provider: ProviderSummary,
  credential: ProviderCredentialSummary
): string {
  const value = credential.label?.trim() || ''
  if (value && !value.includes('\uFFFD') && !/\?{2,}/.test(value)) {
    return value
  }
  return provider.displayName?.trim() || `${providerKindLabels[provider.kind]}账号`
}

function QuotaWindow({
  title,
  value
}: {
  readonly title: string
  readonly value: ProviderQuotaWindow | null
}) {
  const remaining = value?.remainingPercent
  const percent = remaining === null || remaining === undefined
    ? null
    : Math.max(0, Math.min(100, remaining))
  return (
    <div className="quota-window">
      <div>
        <span>{title}</span>
        <strong>{percent === null ? '待同步' : `${percent.toFixed(0)}%`}</strong>
      </div>
      <div className="quota-track" aria-label={`${title}剩余额度`}>
        <i style={{ width: `${percent ?? 0}%` }} />
      </div>
      <small>
        {value?.resetsAt ? `重置：${dateTime(value.resetsAt)}` : '暂无重置时间'}
      </small>
    </div>
  )
}

function CredentialCard({
  provider,
  credential,
  busy,
  onRun,
  client
}: {
  readonly provider: ProviderSummary
  readonly credential: ProviderCredentialSummary
  readonly busy: boolean
  readonly onRun: (operation: () => Promise<unknown>) => void
  readonly client: ManagementApiClient
}) {
  const routing = credential.routing
  const state = statusLabel(credential.status, routing?.enabled !== false)
  const saveRouting = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!routing) return
    const values = new FormData(event.currentTarget)
    onRun(() => client.updateProviderCredentialRouting(provider.id, credential.id, {
      label: String(values.get('label') || credentialLabel(provider, credential)),
      routingEnabled: values.get('routingEnabled') === 'on',
      routingWeight: Number(values.get('routingWeight') || 1),
      lowQuotaThreshold: Number(values.get('lowQuotaThreshold') || 0),
      dailyRequestLimit: Number(values.get('dailyRequestLimit') || 0),
      dailyTokenLimit: Number(values.get('dailyTokenLimit') || 0),
      reservedModels: String(values.get('reservedModels') || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    }))
  }
  const label = credentialLabel(provider, credential)
  const initials = Array.from(label.trim()).slice(0, 2).join('').toUpperCase() || 'AI'

  return (
    <article className={`upstream-account-card ${state.tone}`}>
      <header className="upstream-account-head">
        <div className="upstream-account-identity">
          <span className="upstream-account-avatar">{initials}</span>
          <div>
            <div className="account-title-row">
              <strong>{label}</strong>
              <span className={`account-state ${state.tone}`}>{state.label}</span>
            </div>
            <small>
              {credential.planType || providerKindLabels[provider.kind]}
              {credential.accountIdPreview ? ` · ${credential.accountIdPreview}` : ''}
            </small>
          </div>
        </div>
        <button
          type="button"
          disabled={busy || provider.kind !== 'chatgpt'}
          onClick={() => onRun(() =>
            client.refreshProviderCredentialUsage(provider.id, credential.id)
          )}
        >
          刷新额度
        </button>
      </header>

      <section className="account-card-section">
        <div className="account-section-title">
          <div>
            <strong>额度状态</strong>
            <span>
              {credential.quota.source === 'provider'
                ? `上游真实额度 · ${credential.quota.updatedAt
                  ? dateTime(credential.quota.updatedAt)
                  : '尚未同步'}`
                : '该凭据没有可用的上游额度接口'}
            </span>
          </div>
        </div>
        <div className="quota-window-grid">
          <QuotaWindow title="短周期" value={credential.quota.primary} />
          <QuotaWindow title="长周期" value={credential.quota.secondary} />
        </div>
        {credential.quota.syncError && (
          <p className="account-inline-alert">{credential.quota.syncError}</p>
        )}
      </section>

      <section className="account-card-section">
        <div className="account-section-title">
          <div>
            <strong>运行表现</strong>
            <span>{credential.health.requests ? '真实请求统计' : '等待请求样本'}</span>
          </div>
        </div>
        <div className="account-kpi-grid">
          <div><span>成功率</span><strong>
            {credential.health.successRate === null
              ? '—'
              : `${credential.health.successRate.toFixed(1)}%`}
          </strong></div>
          <div><span>请求数</span><strong>{credential.health.requests}</strong></div>
          <div><span>P95 延迟</span><strong>
            {credential.health.requests ? `${credential.health.p95LatencyMs} ms` : '—'}
          </strong></div>
          <div><span>并发</span><strong>
            {credential.runtime.concurrencyLimit
              ? `${credential.runtime.activeRequests}/${credential.runtime.concurrencyLimit}`
              : '—'}
          </strong></div>
        </div>
        {(credential.runtime.cooldownUntil || credential.health.lastErrorMessage) && (
          <p className="account-inline-alert">
            {credential.runtime.cooldownUntil
              ? `预计恢复：${dateTime(credential.runtime.cooldownUntil)}`
              : `最近错误：${credential.health.lastErrorMessage}`}
          </p>
        )}
      </section>

      {routing && (
        <form className="account-routing-form" onSubmit={saveRouting}>
          <div className="account-section-title">
            <div>
              <strong>调度设置</strong>
              <span>沿用 Proxy 账号池策略</span>
            </div>
          </div>
          <div className="routing-fields">
            <label>账号名称
              <input name="label" defaultValue={label} maxLength={80} />
            </label>
            <label>路由权重
              <input
                name="routingWeight"
                type="number"
                min={1}
                max={100}
                defaultValue={routing.weight}
              />
            </label>
            <label>额度保护线（%）
              <input
                name="lowQuotaThreshold"
                type="number"
                min={0}
                max={100}
                defaultValue={routing.lowQuotaThreshold}
              />
            </label>
            <label>每日请求上限
              <input
                name="dailyRequestLimit"
                type="number"
                min={0}
                defaultValue={routing.dailyRequestLimit}
              />
            </label>
            <label>每日 Token 上限
              <input
                name="dailyTokenLimit"
                type="number"
                min={0}
                defaultValue={routing.dailyTokenLimit}
              />
            </label>
            <label>保留模型（逗号分隔）
              <input
                name="reservedModels"
                defaultValue={routing.reservedModels.join(', ')}
                placeholder="gpt-5.4, gpt-5.5"
              />
            </label>
          </div>
          <div className="account-routing-actions">
            <label className="routing-toggle">
              <input
                name="routingEnabled"
                type="checkbox"
                defaultChecked={routing.enabled}
              />
              允许该账号参与自动路由
            </label>
            <button type="submit" disabled={busy}>保存调度设置</button>
          </div>
        </form>
      )}

      <footer className="upstream-account-footer">
        <span>
          凭据：{credential.maskedPreview} · {credential.storageFormat}
        </span>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`确定移除上游账号“${label}”吗？`)) return
            onRun(() => client.deleteProviderCredential(provider.id, credential.id))
          }}
        >
          移除账号
        </button>
      </footer>
    </article>
  )
}

export function ProvidersPage({
  client,
  providers,
  models,
  compact = false,
  onRefresh
}: {
  readonly client: ManagementApiClient
  readonly providers: ProviderListResponse
  readonly models: ModelRouteResponse
  readonly compact?: boolean
  readonly onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [accountLabel, setAccountLabel] = useState('')
  const [routingEnabled, setRoutingEnabled] = useState(true)
  const [accountDialogError, setAccountDialogError] = useState<string | null>(null)
  const [selectedAuthFile, setSelectedAuthFile] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [nativeImportPending, setNativeImportPending] = useState(false)
  const [loginStatus, setLoginStatus] = useState<ChatgptAccountLoginStatus | null>(null)
  const authJsonRef = useRef<HTMLTextAreaElement>(null)
  const authFileRef = useRef<HTMLInputElement>(null)
  const loginPollPending = useRef(false)
  const importAuthJsonRef = useRef<(raw: string) => Promise<void>>(async () => undefined)

  const run = async (operation: () => Promise<unknown>, success = '设置已保存。') => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
      await onRefresh()
      setNotice(success)
    } catch {
      setError('Provider 操作失败，请检查配置、账号状态和管理员权限。')
    } finally {
      setBusy(false)
    }
  }

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const kind = String(values.get('kind')) as ProviderSummary['kind']
    const baseUrl = String(values.get('baseUrl') || '').trim()
    const configuredModels = String(values.get('models') || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    void run(async () => {
      await client.createProvider({
        kind,
        displayName: String(values.get('displayName') || ''),
        config: { ...(baseUrl ? { baseUrl } : {}), models: configuredModels }
      })
      form.reset()
    }, 'Provider 已创建。')
  }

  const credential = (event: FormEvent<HTMLFormElement>, providerId: string) => {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.namedItem('secret') as HTMLInputElement | null
    const secret = input?.value || ''
    if (input) input.value = ''
    void run(
      () => client.addProviderCredential(providerId, secret),
      '上游账号凭据已保存。'
    )
  }

  const clearSensitiveAccountInput = () => {
    if (authJsonRef.current) authJsonRef.current.value = ''
    if (authFileRef.current) authFileRef.current.value = ''
    setSelectedAuthFile(null)
  }

  const closeAccountDialog = () => {
    clearSensitiveAccountInput()
    setAccountDialogOpen(false)
    setAccountDialogError(null)
    setNativeImportPending(false)
    setLoginStatus(null)
    setAccountLabel('')
    setRoutingEnabled(true)
  }

  const validateAuthJson = (raw: string): string | null => {
    if (!raw.trim()) return '请粘贴或选择 auth.json。'
    if (raw.length > 256 * 1024) return 'auth.json 超过 256 KB，已拒绝读取。'
    try {
      const parsed = JSON.parse(raw) as {
        tokens?: {
          access_token?: unknown
          refresh_token?: unknown
          account_id?: unknown
        }
      }
      if (
        typeof parsed.tokens?.access_token !== 'string' ||
        typeof parsed.tokens?.refresh_token !== 'string' ||
        typeof parsed.tokens?.account_id !== 'string'
      ) {
        return 'auth.json 缺少 access_token、refresh_token 或 account_id。'
      }
    } catch {
      return 'auth.json 不是有效的 JSON。'
    }
    return null
  }

  const importAuthJson = async (raw: string) => {
    if (busy) return
    const validationError = validateAuthJson(raw)
    if (validationError) {
      setAccountDialogError(validationError)
      setNativeImportPending(false)
      return
    }
    let secret = raw
    setBusy(true)
    setError(null)
    setNotice(null)
    setAccountDialogError(null)
    try {
      const result = await client.importChatgptAccount({
        authJson: secret,
        label: accountLabel.trim(),
        routingEnabled
      })
      await onRefresh()
      closeAccountDialog()
      setNotice(result.created
        ? routingEnabled
          ? '订阅账号已导入并参与自动路由。'
          : '订阅账号已导入，当前仅保存到账号池。'
        : '已更新同一订阅账号的登录凭据和路由设置。')
    } catch {
      setAccountDialogError('订阅账号导入失败，请确认 auth.json 有效且当前账号具有一级管理员权限。')
    } finally {
      secret = ''
      clearSensitiveAccountInput()
      setNativeImportPending(false)
      setBusy(false)
    }
  }
  importAuthJsonRef.current = importAuthJson

  const readAuthFile = async (file: File | undefined) => {
    if (!file) return
    setAccountDialogError(null)
    if (!file.name.toLowerCase().endsWith('.json')) {
      setAccountDialogError('请选择 auth.json 文件。')
      return
    }
    if (file.size <= 0 || file.size > 256 * 1024) {
      setAccountDialogError('auth.json 必须是小于 256 KB 的非空文件。')
      return
    }
    let text = ''
    try {
      text = await file.text()
      const validationError = validateAuthJson(text)
      if (validationError) {
        setAccountDialogError(validationError)
        return
      }
      if (authJsonRef.current) authJsonRef.current.value = text
      setSelectedAuthFile(file.name)
    } catch {
      setAccountDialogError('无法读取 auth.json 文件。')
    } finally {
      text = ''
    }
  }

  const requestCurrentCodexAccount = () => {
    if (busy || nativeImportPending) return
    setAccountDialogError(null)
    setNativeImportPending(true)
    const link = document.createElement('a')
    link.href = 'ai-editor-code://import-current-codex-account'
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
  }

  const startShortcutOfficialLogin = async () => {
    if (busy) return
    setBusy(true)
    setAccountDialogError(null)
    try {
      setLoginStatus(await client.startChatgptAccountLogin({
        label: accountLabel.trim(),
        routingEnabled
      }))
    } catch {
      setAccountDialogError('OpenAI 官方登录启动失败，请检查 Codex CLI 和管理员权限。')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!accountDialogOpen) return
    const receive = (event: MessageEvent) => {
      const message = currentCodexAuthFromEvent(event, window.location.origin)
      if (!message) return
      setNativeImportPending(false)
      if (message.errorId) {
        setAccountDialogError(message.errorId === 'current_codex_account_import_cancelled'
          ? '已取消导入当前 Codex 账号。'
          : '无法读取当前 Codex 账号，请确认本机已登录 Codex。')
        return
      }
      if (message.authJson) void importAuthJsonRef.current(message.authJson)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  })

  useEffect(() => {
    if (!accountDialogOpen || loginStatus?.status !== 'waiting') return
    let disposed = false
    const poll = async () => {
      if (loginPollPending.current) return
      loginPollPending.current = true
      try {
        const status = await client.chatgptAccountLoginStatus()
        if (disposed) return
        setLoginStatus(status)
        if (status.status === 'success') {
          await onRefresh()
          if (disposed) return
          closeAccountDialog()
          setNotice(routingEnabled
            ? 'ChatGPT 官方账号已接入并参与自动路由。'
            : 'ChatGPT 官方账号已接入，当前仅保存到账号池。')
        } else if (status.status === 'error' || status.status === 'cancelled') {
          setAccountDialogError(status.message || 'OpenAI 官方登录未完成。')
        }
      } catch {
        if (!disposed) setAccountDialogError('无法刷新 OpenAI 官方登录状态。')
      } finally {
        loginPollPending.current = false
      }
    }
    const timer = window.setInterval(() => void poll(), 1200)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [accountDialogOpen, client, loginStatus?.status, onRefresh, routingEnabled])

  const internalBudget = (event: FormEvent<HTMLFormElement>, providerId: string) => {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const value = String(values.get('internalBudgetCredits') || '').trim()
    void run(
      () => client.setProviderInternalBudget(providerId, value || null),
      value ? 'Provider 内部预算已更新。' : 'Provider 内部预算已取消。'
    )
  }

  const activeProviders = providers.providers.filter(provider => provider.status === 'active')
  const credentials = providers.providers.flatMap(provider => provider.credentials)
  const activeAccounts = credentials.filter(item =>
    item.routing?.enabled !== false && item.status === 'active'
  )
  const providerName = new Map(providers.providers.map(item => [item.id, item.displayName]))
  const rateByModel = new Map((models.rates || []).map(rate => [rate.modelId, rate]))

  if (compact) {
    return (
      <CompactManagementPage
        client={client}
        providers={providers}
        fullRoute="providers"
        onRefresh={onRefresh}
      />
    )
  }

  return (
    <>
      <section className="provider-hero" aria-labelledby="providers-title">
        <div className="provider-hero-copy">
          <p className="eyebrow">LEVEL 1 · CENTRAL GATEWAY</p>
          <h2 id="providers-title">Provider 与模型</h2>
          <p>集中管理上游账号、额度、健康状态和模型路由。所有调度行为沿用现有 Proxy。</p>
          <p className="muted">
            ChatGPT 订阅账号池属于试验通道，可由一级管理员随时停用，不承诺可用性。
          </p>
          <button
            type="button"
            className="provider-primary-action"
            onClick={() => setAccountDialogOpen(true)}
          >
            添加订阅账号
          </button>
        </div>
        <div className="provider-summary-grid">
          <div><span>Provider</span><strong>{activeProviders.length}/{providers.providers.length}</strong></div>
          <div><span>上游账号</span><strong>{credentials.length}</strong></div>
          <div><span>可调度账号</span><strong>{activeAccounts.length}</strong></div>
          <div><span>模型路由</span><strong>{models.models.filter(model => model.enabled).length}</strong></div>
        </div>
      </section>

      {providers.warning && <p className="warning" role="alert">{providers.warning}</p>}
      {error && <p className="warning" role="alert">{error}</p>}
      {notice && <p className="provider-notice" role="status">{notice}</p>}

      <details className="content-card provider-create-panel">
        <summary>新增 Provider</summary>
        <form className="provider-form" onSubmit={create}>
          <label>类型
            <select name="kind" defaultValue="relay">
              <option value="chatgpt">ChatGPT 订阅（试验通道）</option>
              <option value="openai">OpenAI API</option>
              <option value="deepseek">DeepSeek</option>
              <option value="relay">Relay</option>
            </select>
          </label>
          <label>名称<input name="displayName" required maxLength={240} /></label>
          <label>Base URL<input name="baseUrl" placeholder="https://..." /></label>
          <label>模型（逗号分隔）<input name="models" placeholder="gpt-5.4-mini" /></label>
          <button type="submit" disabled={busy}>创建 Provider</button>
        </form>
      </details>

      {providers.providers.length === 0 ? (
        <section className="content-card">
          <p className="muted">尚未配置 Provider。</p>
        </section>
      ) : providers.providers.map(provider => (
        <section className="provider-group" key={provider.id}>
          <header className="provider-group-header">
            <div>
              <div className="provider-heading-line">
                <h2>{provider.displayName}</h2>
                <span className={`provider-status ${provider.status}`}>
                  {provider.status === 'active' ? '运行中' : '已停用'}
                </span>
              </div>
              <p>
                {providerKindLabels[provider.kind]} · {provider.config.baseUrl || '使用默认上游地址'}
              </p>
              {provider.runtimeHealth && (
                <div className="provider-runtime-summary">
                  <span>健康：{statusLabel(provider.runtimeHealth.state, true).label}</span>
                  <span>熔断：{provider.runtimeHealth.circuitState === 'open' ? '已打开' : '正常'}</span>
                  <span>
                    最近检测：{provider.runtimeHealth.lastCheckedAt
                      ? dateTime(provider.runtimeHealth.lastCheckedAt)
                      : '等待请求'}
                  </span>
                </div>
              )}
            </div>
            <div className="button-row">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => client.updateProvider(provider.id, {
                  status: provider.status === 'active' ? 'disabled' : 'active'
                }), provider.status === 'active' ? 'Provider 已停用。' : 'Provider 已启用。')}
              >
                {provider.status === 'active' ? '停用 Provider' : '启用 Provider'}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`确定删除 Provider“${provider.displayName}”及其模型路由吗？`)) return
                  void run(() => client.deleteProvider(provider.id), 'Provider 已删除。')
                }}
              >
                删除
              </button>
            </div>
          </header>

          <div className="provider-usage-toolbar">
            <div className="provider-usage-metrics">
              <div><span>Gateway 请求</span><strong>{provider.usage?.requests || 0}</strong></div>
              <div><span>输入 Token</span><strong>{provider.usage?.inputTokens || 0}</strong></div>
              <div><span>输出 Token</span><strong>{provider.usage?.outputTokens || 0}</strong></div>
              <div><span>已结算积分</span><strong>
                {provider.usage?.settledCredits || '0.000000'}
              </strong></div>
            </div>
            {provider.kind !== 'chatgpt' && (
              <form onSubmit={event => internalBudget(event, provider.id)}>
                <label>内部预算（积分）
                  <input
                    name="internalBudgetCredits"
                    inputMode="decimal"
                    defaultValue={provider.usage?.internalBudgetCredits || ''}
                    placeholder="留空表示不设置"
                  />
                </label>
                <div>
                  <span>
                    {provider.usage?.remainingCredits === null ||
                    provider.usage?.remainingCredits === undefined
                      ? '显示 Gateway 实际用量，不伪造上游额度'
                      : `剩余 ${provider.usage.remainingCredits} · 已用 ${
                        provider.usage.usedPercent || '0'
                      }%`}
                  </span>
                  <button type="submit" disabled={busy}>保存预算</button>
                </div>
              </form>
            )}
          </div>

          {provider.kind === 'chatgpt' && (
            <div className="account-pool-toolbar">
              <div>
                <strong>账号池调度</strong>
                <span>
                  试验通道 · 队列 {providers.accountPool.queueDepth} ·
                  自动跳过冷却、登录失效和额度保护账号
                </span>
              </div>
              <label>路由策略
                <select
                  value={providers.accountPool.strategy}
                  disabled={busy}
                  onChange={event => void run(
                    () => client.setProviderAccountStrategy(
                      provider.id,
                      event.target.value as AccountRoutingStrategy
                    ),
                    '账号池路由策略已更新。'
                  )}
                >
                  {Object.entries(strategyLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="upstream-account-grid">
            {provider.credentials.map(item => (
              <CredentialCard
                key={item.id}
                provider={provider}
                credential={item}
                busy={busy}
                onRun={operation => void run(operation)}
                client={client}
              />
            ))}
          </div>

          {provider.credentials.length === 0 && (
            <p className="provider-empty">还没有上游账号，请通过官方登录或手动保存凭据。</p>
          )}

          {provider.kind !== 'chatgpt' && (
            <form className="credential-form provider-manual-credential" onSubmit={event =>
              credential(event, provider.id)
            }>
              <label>手动添加凭据
                <input name="secret" type="password" required autoComplete="off" aria-label="新凭据" />
              </label>
              <button type="submit" disabled={busy}>保存凭据</button>
            </form>
          )}
        </section>
      ))}

      {accountDialogOpen && (
        <div
          className="account-import-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !busy) closeAccountDialog()
          }}
        >
          <section
            className="account-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-import-title"
          >
            <header>
              <div>
                <p className="eyebrow">CHATGPT ACCOUNT</p>
                <h2 id="account-import-title">添加订阅账号</h2>
                <p>无需预先创建 Provider；系统会自动创建或复用 ChatGPT 订阅池。</p>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭"
                disabled={busy}
                onClick={closeAccountDialog}
              >
                ×
              </button>
            </header>

            <div className="account-import-settings">
              <label>账号名称
                <input
                  value={accountLabel}
                  maxLength={80}
                  placeholder="例如：主账号、备用账号"
                  onChange={event => setAccountLabel(event.target.value)}
                />
              </label>
              <label className="routing-toggle">
                <input
                  type="checkbox"
                  checked={routingEnabled}
                  onChange={event => setRoutingEnabled(event.target.checked)}
                />
                导入后立即参与自动路由
              </label>
              <small>默认立即参与路由；如需仅保存凭据，可在导入前关闭此项。</small>
            </div>

            <div className="account-import-options">
              <button
                type="button"
                disabled={busy}
                onClick={() => void startShortcutOfficialLogin()}
              >
                <strong>OpenAI 官方登录</strong>
                <span>通过隔离 Codex 登录流程添加新账号</span>
              </button>
              <button
                type="button"
                disabled={busy || nativeImportPending}
                onClick={requestCurrentCodexAccount}
              >
                <strong>{nativeImportPending ? '等待 Code 确认…' : '一键导入当前 Codex 账号'}</strong>
                <span>读取本机 CODEX_HOME/auth.json</span>
              </button>
              <button
                type="button"
                className={dragActive ? 'drag-active' : undefined}
                disabled={busy}
                onClick={() => authFileRef.current?.click()}
                onDragEnter={event => {
                  event.preventDefault()
                  setDragActive(true)
                }}
                onDragOver={event => event.preventDefault()}
                onDragLeave={() => setDragActive(false)}
                onDrop={event => {
                  event.preventDefault()
                  setDragActive(false)
                  void readAuthFile(event.dataTransfer.files[0])
                }}
              >
                <strong>选择或拖入 auth.json</strong>
                <span>{selectedAuthFile || '从其他 Codex 环境导入登录文件'}</span>
              </button>
              <input
                ref={authFileRef}
                type="file"
                hidden
                accept=".json,application/json"
                aria-label="选择 auth.json"
                onChange={event => void readAuthFile(event.target.files?.[0])}
              />
            </div>

            {loginStatus && (
              <div className={`account-login-status ${loginStatus.status}`}>
                <strong>{loginStatus.message || (
                  loginStatus.status === 'waiting' ? '等待完成 OpenAI 官方登录…' : loginStatus.status
                )}</strong>
                {loginStatus.verificationUrl && (
                  <a href={loginStatus.verificationUrl} target="_blank" rel="noreferrer">
                    在系统浏览器中打开 OpenAI 登录
                  </a>
                )}
                {loginStatus.userCode && (
                  <span className="device-auth-code">
                    一次性代码 <code>{loginStatus.userCode}</code>
                  </span>
                )}
              </div>
            )}

            <div className="account-import-divider"><span>或者手动粘贴</span></div>
            <form
              className="account-import-manual"
              onSubmit={event => {
                event.preventDefault()
                void importAuthJson(authJsonRef.current?.value || '')
              }}
            >
              <label>auth.json 内容
                <textarea
                  ref={authJsonRef}
                  rows={7}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="粘贴 Codex CLI 生成的完整 auth.json"
                />
              </label>
              <div>
                <small>凭据只提交给 Gateway，不写入 localStorage，也不会在页面中回显。</small>
                <button type="submit" disabled={busy}>
                  {busy ? '正在导入…' : '导入账号'}
                </button>
              </div>
            </form>
            {accountDialogError && (
              <p className="warning" role="alert">{accountDialogError}</p>
            )}
          </section>
        </div>
      )}

      <section className="content-card model-route-panel" aria-labelledby="routes-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">MODEL CATALOG</p>
            <h2 id="routes-title">模型路由</h2>
          </div>
          <span>{models.models.filter(model => model.enabled).length} 条已启用</span>
        </div>
        {models.models.length === 0 ? (
          <p className="muted">暂无模型路由。</p>
        ) : (
          <div className="model-route-grid">
            {models.models.map(model => (
              <article key={model.id}>
                <div>
                  <strong>{model.publicModelId}</strong>
                  <span>{providerName.get(model.providerId) || model.providerId}</span>
                </div>
                <dl>
                  <div><dt>上游模型</dt><dd>{model.upstreamModelId}</dd></div>
                  <div><dt>积分倍率</dt><dd>
                    {rateByModel.get(model.publicModelId)?.multiplier || '1.000000'}×
                  </dd></div>
                </dl>
                <form
                  className="model-route-controls"
                  onSubmit={event => {
                    event.preventDefault()
                    const values = new FormData(event.currentTarget)
                    void run(() => client.putModel(model.publicModelId, {
                      providerId: model.providerId,
                      upstreamModelId: model.upstreamModelId,
                      priority: Number(values.get('priority') || model.priority),
                      enabled: model.enabled
                    }), '模型路由优先级已保存。')
                  }}
                >
                  <label>路由优先级
                    <input
                      name="priority"
                      type="number"
                      min={1}
                      max={10000}
                      defaultValue={model.priority}
                    />
                  </label>
                  <button type="submit" disabled={busy}>保存优先级</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => client.putModel(model.publicModelId, {
                      providerId: model.providerId,
                      upstreamModelId: model.upstreamModelId,
                      priority: model.priority,
                      enabled: !model.enabled
                    }), model.enabled ? '模型路由已停用。' : '模型路由已启用。')}
                  >
                    {model.enabled ? '停用路由' : '启用路由'}
                  </button>
                </form>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="content-card route-decision-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ROUTING TRACE</p>
            <h2>最近路由决策</h2>
          </div>
          <span>仅显示脱敏信息</span>
        </div>
        {providers.accountPool.recentRouteDecisions.length === 0 ? (
          <p className="muted">暂无账号路由记录，完成一次 ChatGPT 请求后将在这里显示。</p>
        ) : (
          <ul>
            {providers.accountPool.recentRouteDecisions.map((decision, index) => (
              <li key={`${decision.at}-${index}`}>
                <div>
                  <strong>{decision.selectedAccountLabel || '未选中账号'}</strong>
                  <span>{decision.model || '未记录模型'} · {dateTime(decision.at)}</span>
                </div>
                <span>{decision.outcome} · 等待 {decision.queueWaitMs} ms</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
