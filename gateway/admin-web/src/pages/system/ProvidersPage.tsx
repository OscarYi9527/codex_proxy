import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  managementErrorMessage,
  type ManagementApiClient
} from '../../app/api-client'
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

function accountState(
  status: string,
  routingEnabled: boolean
): {
  readonly label: string
  readonly tone: 'healthy' | 'warning' | 'danger' | 'muted'
} {
  if (!routingEnabled) return { label: '未参与路由', tone: 'muted' }
  if (status === 'active' || status === 'healthy') {
    return { label: '参与路由', tone: 'healthy' }
  }
  if (status === 'cooldown') return { label: '冷却中', tone: 'warning' }
  if (status === 'degraded') return { label: '状态下降', tone: 'warning' }
  if (status === 'auth_error') return { label: '需要重新登录', tone: 'danger' }
  if (status === 'circuit_open' || status === 'unhealthy') {
    return { label: '暂不可用', tone: 'danger' }
  }
  if (status === 'disabled') return { label: '已停用', tone: 'muted' }
  return { label: '等待检测', tone: 'warning' }
}

function accountLabel(
  provider: ProviderSummary,
  credential: ProviderCredentialSummary
): string {
  const label = credential.label?.trim() || ''
  if (label && !label.includes('\uFFFD') && !/\?{2,}/.test(label)) return label
  const providerName = provider.displayName?.trim() || ''
  if (
    providerName &&
    !providerName.includes('\uFFFD') &&
    !/\?{2,}/.test(providerName)
  ) {
    return providerName
  }
  return 'ChatGPT 订阅账号'
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

function SubscriptionAccountCard({
  provider,
  credential,
  busy,
  client,
  onRun
}: {
  readonly provider: ProviderSummary
  readonly credential: ProviderCredentialSummary
  readonly busy: boolean
  readonly client: ManagementApiClient
  readonly onRun: (
    operation: () => Promise<unknown>,
    success?: string
  ) => Promise<void>
}) {
  const routing = credential.routing
  const routingEnabled = routing?.enabled !== false
  const state = accountState(credential.status, routingEnabled)
  const label = accountLabel(provider, credential)
  const initials = Array.from(label).slice(0, 2).join('').toUpperCase() || 'AI'

  const saveRouting = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    void onRun(
      () => client.updateProviderCredentialRouting(provider.id, credential.id, {
        label: String(values.get('label') || label).trim() || label,
        routingEnabled: values.get('routingEnabled') === 'on',
        routingWeight: Number(values.get('routingWeight') || routing?.weight || 1)
      }),
      '账号名称和路由设置已保存。'
    )
  }

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
              {credential.planType || 'ChatGPT 订阅'}
              {credential.accountIdPreview ? ` · ${credential.accountIdPreview}` : ''}
            </small>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRun(
            () => client.refreshProviderCredentialUsage(provider.id, credential.id),
            '账号额度已刷新。'
          )}
        >
          刷新额度
        </button>
      </header>

      <section className="account-card-section">
        <div className="account-section-title">
          <div>
            <strong>可用额度</strong>
            <span>
              {credential.quota.updatedAt
                ? `最近同步：${dateTime(credential.quota.updatedAt)}`
                : '尚未从上游同步'}
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
        {!credential.quota.syncError && credential.runtime.cooldownUntil && (
          <p className="account-inline-alert">
            账号正在冷却，预计恢复：{dateTime(credential.runtime.cooldownUntil)}
          </p>
        )}
      </section>

      <form className="account-routing-form" onSubmit={saveRouting}>
        <div className="account-section-title">
          <div>
            <strong>账号与路由</strong>
            <span>这里只设置账号名称、是否参与路由和调度权重。</span>
          </div>
        </div>
        <div className="routing-fields subscription-routing-fields">
          <label>账号名称
            <input name="label" defaultValue={label} maxLength={80} />
          </label>
          <label>路由权重
            <input
              name="routingWeight"
              type="number"
              min={1}
              max={1000}
              defaultValue={routing?.weight || 1}
            />
          </label>
        </div>
        <div className="account-routing-actions">
          <label className="routing-toggle">
            <input
              name="routingEnabled"
              type="checkbox"
              defaultChecked={routingEnabled}
            />
            允许该账号参与自动路由
          </label>
          <button type="submit" disabled={busy}>保存</button>
        </div>
      </form>

      <footer className="upstream-account-footer">
        <span>凭据已脱敏保存，页面不会回显 Token。</span>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`确定移除订阅账号“${label}”吗？`)) return
            void onRun(
              () => client.deleteProviderCredential(provider.id, credential.id),
              '订阅账号已移除。'
            )
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
  const [accountLabelValue, setAccountLabelValue] = useState('')
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

  const chatgptProviders = providers.providers.filter(provider => provider.kind === 'chatgpt')
  const accounts = chatgptProviders.flatMap(provider =>
    provider.credentials.map(credential => ({ provider, credential }))
  )
  const enabledAccounts = accounts.filter(
    item => item.credential.routing?.enabled !== false
  )
  const loginErrorAccounts = accounts.filter(
    item => item.credential.status === 'auth_error'
  )
  const primaryProvider = chatgptProviders[0]

  const run = async (
    operation: () => Promise<unknown>,
    success = '设置已保存。'
  ) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
      await onRefresh()
      setNotice(success)
    } catch (caught) {
      setError(managementErrorMessage(
        caught,
        '订阅账号操作失败，请检查账号状态、网络出口和管理员权限。'
      ))
    } finally {
      setBusy(false)
    }
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
    setAccountLabelValue('')
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
        label: accountLabelValue.trim(),
        routingEnabled
      })
      await onRefresh()
      closeAccountDialog()
      setNotice(result.created
        ? routingEnabled
          ? '订阅账号已导入并参与自动路由。'
          : '订阅账号已导入，当前未参与路由。'
        : '已更新同一订阅账号，不会重复创建账号卡片。')
    } catch (caught) {
      setAccountDialogError(managementErrorMessage(
        caught,
        '订阅账号导入失败，请确认 auth.json 有效。'
      ))
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

  const startOfficialLogin = async () => {
    if (busy) return
    setBusy(true)
    setAccountDialogError(null)
    try {
      setLoginStatus(await client.startChatgptAccountLogin({
        label: accountLabelValue.trim(),
        routingEnabled
      }))
    } catch (caught) {
      setAccountDialogError(managementErrorMessage(
        caught,
        'OpenAI 官方登录启动失败，请检查 Codex CLI、外网出口和管理员权限。'
      ))
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
    if (!accountDialogOpen || loginStatus) return
    let disposed = false
    void client.chatgptAccountLoginStatus()
      .then(status => {
        if (!disposed && status.status !== 'idle') setLoginStatus(status)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [accountDialogOpen, client, loginStatus])

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
            : 'ChatGPT 官方账号已接入，当前未参与路由。')
        } else if (status.status === 'error' || status.status === 'cancelled') {
          setAccountDialogError(status.message || 'OpenAI 官方登录未完成。')
        }
      } catch (caught) {
        if (!disposed) {
          setAccountDialogError(managementErrorMessage(
            caught,
            '无法刷新 OpenAI 官方登录状态。'
          ))
        }
      } finally {
        loginPollPending.current = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1200)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [accountDialogOpen, client, loginStatus?.status, onRefresh, routingEnabled])

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
      <section className="provider-hero subscription-account-hero">
        <div className="provider-hero-copy">
          <p className="eyebrow">CHATGPT ACCOUNT POOL</p>
          <h2>订阅账号管理</h2>
          <p>
            这里只管理 ChatGPT 订阅账号、可用额度和账号池路由；
            Provider 密钥、模型配置、组织与系统诊断不会出现在本页面。
          </p>
          <p className="muted">订阅账号池属于试验通道，可由一级管理员随时停用。</p>
          <div className="subscription-account-primary-actions">
            <button
              type="button"
              className="provider-primary-action"
              onClick={() => setAccountDialogOpen(true)}
            >
              添加订阅账号
            </button>
            <button
              type="button"
              className="provider-primary-action secondary"
              disabled={busy || accounts.length === 0}
              onClick={() => void run(async () => {
                for (const item of accounts) {
                  await client.refreshProviderCredentialUsage(
                    item.provider.id,
                    item.credential.id
                  )
                }
              }, '全部订阅账号额度已刷新。')}
            >
              刷新全部额度
            </button>
          </div>
        </div>
        <div className="provider-summary-grid">
          <div><span>订阅账号</span><strong>{accounts.length}</strong></div>
          <div><span>参与路由</span><strong>{enabledAccounts.length}</strong></div>
          <div><span>需要登录</span><strong>{loginErrorAccounts.length}</strong></div>
          <div><span>等待队列</span><strong>{providers.accountPool.queueDepth}</strong></div>
        </div>
      </section>

      {error && <p className="warning" role="alert">{error}</p>}
      {notice && <p className="provider-notice" role="status">{notice}</p>}

      <section className="provider-group subscription-account-pool">
        <div className="account-pool-toolbar">
          <div>
            <strong>账号池路由</strong>
            <span>自动跳过登录失效、冷却中和额度不足的账号。</span>
          </div>
          <label>路由策略
            <select
              value={providers.accountPool.strategy}
              disabled={busy || !primaryProvider}
              onChange={event => {
                if (!primaryProvider) return
                void run(
                  () => client.setProviderAccountStrategy(
                    primaryProvider.id,
                    event.target.value as AccountRoutingStrategy
                  ),
                  '账号池路由策略已更新。'
                )
              }}
            >
              {Object.entries(strategyLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        {accounts.length === 0 ? (
          <div className="provider-empty">
            <strong>还没有订阅账号</strong>
            <p>点击“添加订阅账号”，通过 OpenAI 官方登录或导入 auth.json。</p>
          </div>
        ) : (
          <div className="upstream-account-grid">
            {accounts.map(({ provider, credential }) => (
              <SubscriptionAccountCard
                key={credential.id}
                provider={provider}
                credential={credential}
                busy={busy}
                client={client}
                onRun={run}
              />
            ))}
          </div>
        )}
      </section>

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
                <p>复用现有 Proxy 的账号导入方式；重复账号只更新凭据，不重复创建。</p>
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
                  value={accountLabelValue}
                  maxLength={80}
                  placeholder="例如：主账号、备用账号"
                  onChange={event => setAccountLabelValue(event.target.value)}
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
              <small>关闭后只保存账号，不参与 AI 请求调度。</small>
            </div>

            <div className="account-import-options">
              <button type="button" disabled={busy} onClick={() => void startOfficialLogin()}>
                <strong>OpenAI 官方登录</strong>
                <span>使用一次性代码安全接入新订阅账号</span>
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

            {loginStatus && loginStatus.status !== 'idle' && (
              <div className={`account-login-status ${loginStatus.status}`}>
                <strong>{loginStatus.message || '等待完成 OpenAI 官方登录…'}</strong>
                <div className="subscription-login-actions">
                  {loginStatus.userCode && (
                    <>
                      <span className="device-auth-code">
                        一次性代码 <code>{loginStatus.userCode}</code>
                      </span>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(loginStatus.userCode || '')}
                      >
                        复制代码
                      </button>
                    </>
                  )}
                  {loginStatus.verificationUrl && (
                    <a href={loginStatus.verificationUrl} target="_blank" rel="noreferrer">
                      打开 OpenAI 登录页
                    </a>
                  )}
                </div>
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
    </>
  )
}
