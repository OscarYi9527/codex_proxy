import { useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type {
  AccountDetails,
  ManagementRoute,
  ProviderCredentialSummary,
  ProviderListResponse,
  ProviderQuotaWindow,
  ProviderSummary
} from '../../app/types'

function statusLabel(status: string, routingEnabled: boolean): string {
  if (!routingEnabled) return '路由已关闭'
  if (status === 'active' || status === 'healthy') return '路由正常'
  if (status === 'auth_error') return '登录失效'
  if (status === 'cooldown') return '冷却中'
  if (status === 'disabled') return '已停用'
  return '需要检查'
}

function quotaText(value: ProviderQuotaWindow | null): string {
  const remaining = value?.remainingPercent
  return remaining === null || remaining === undefined
    ? '待同步'
    : `${Math.max(0, Math.min(100, remaining)).toFixed(0)}%`
}

function accountLabel(
  provider: ProviderSummary,
  credential: ProviderCredentialSummary
): string {
  const value = credential.label?.trim() || ''
  return value && !value.includes('\uFFFD') && !/\?{2,}/.test(value)
    ? value
    : provider.displayName
}

export function CompactManagementPage({
  client,
  account,
  providers,
  fullRoute,
  onRefresh
}: {
  readonly client: ManagementApiClient
  readonly account: AccountDetails
  readonly providers: ProviderListResponse | null
  readonly fullRoute: ManagementRoute
  readonly onRefresh: () => Promise<void>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const subscriptionAccounts = (providers?.providers || [])
    .filter(provider => provider.kind === 'chatgpt')
    .flatMap(provider => provider.credentials.map(credential => ({ provider, credential })))
  const fullManagementUrl =
    `ai-editor-code://open-full-management?route=${encodeURIComponent(fullRoute)}`

  const run = async (id: string, operation: () => Promise<unknown>, message: string) => {
    if (busyId) return
    setBusyId(id)
    setNotice(null)
    try {
      await operation()
      await onRefresh()
      setNotice(message)
    } catch {
      setNotice('操作失败，请稍后重试或打开完整管理页面查看。')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <main className="compact-management">
      <header className="compact-management-header">
        <div>
          <p className="eyebrow">AI EDITOR</p>
          <h1>快速管理</h1>
          <p>仅显示账号路由和额度。</p>
        </div>
        <a className="full-management-link" href={fullManagementUrl}>
          在浏览器打开完整管理页面
        </a>
      </header>

      {notice && <p className="compact-notice" role="status">{notice}</p>}

      <section className="compact-summary-grid" aria-label="账号与积分摘要">
        <article>
          <span>产品账号</span>
          <strong>{account.account.loginName || account.account.email || 'AI Editor 用户'}</strong>
          <small>{account.account.status === 'active' ? '账号正常' : '账号不可用'}</small>
        </article>
        <article>
          <span>可用积分</span>
          <strong>{account.credits.available}</strong>
          <small>本期已使用 {account.credits.settled}</small>
        </article>
      </section>

      {account.account.mustChangePassword && (
        <p className="compact-warning">
          当前账号必须先修改密码，请在完整管理页面完成。
        </p>
      )}

      <section className="compact-account-list" aria-labelledby="compact-routing-title">
        <div className="compact-section-title">
          <div>
            <h2 id="compact-routing-title">订阅账号路由</h2>
            <p>开启或关闭账号参与自动路由，并查看上游剩余额度。</p>
          </div>
          <button
            type="button"
            disabled={Boolean(busyId)}
            onClick={() => void run('refresh-all', onRefresh, '账号状态已刷新。')}
          >
            刷新
          </button>
        </div>

        {subscriptionAccounts.map(({ provider, credential }) => {
          const routingEnabled = credential.routing?.enabled === true
          const label = accountLabel(provider, credential)
          return (
            <article className="compact-account-row" key={credential.id}>
              <div className="compact-account-main">
                <span className="compact-account-avatar">
                  {Array.from(label).slice(0, 2).join('').toUpperCase() || 'AI'}
                </span>
                <div>
                  <strong>{label}</strong>
                  <small>
                    {statusLabel(credential.status, routingEnabled)}
                    {credential.accountIdPreview ? ` · ${credential.accountIdPreview}` : ''}
                  </small>
                </div>
              </div>
              <div className="compact-quota">
                <span>短周期 <strong>{quotaText(credential.quota.primary)}</strong></span>
                <span>长周期 <strong>{quotaText(credential.quota.secondary)}</strong></span>
              </div>
              <div className="compact-account-actions">
                <button
                  type="button"
                  disabled={Boolean(busyId) || !credential.routing}
                  onClick={() => void run(
                    credential.id,
                    () => client.updateProviderCredentialRouting(provider.id, credential.id, {
                      label,
                      routingEnabled: !routingEnabled
                    }),
                    routingEnabled ? '该账号已关闭路由。' : '该账号已开启路由。'
                  )}
                >
                  {routingEnabled ? '关闭路由' : '开启路由'}
                </button>
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void run(
                    `${credential.id}:quota`,
                    () => client.refreshProviderCredentialUsage(provider.id, credential.id),
                    '额度已刷新。'
                  )}
                >
                  刷新额度
                </button>
              </div>
            </article>
          )
        })}

        {subscriptionAccounts.length === 0 && (
          <p className="compact-empty">
            暂无可管理的订阅账号，请在完整管理页面中添加或检查账号。
          </p>
        )}
      </section>
    </main>
  )
}
