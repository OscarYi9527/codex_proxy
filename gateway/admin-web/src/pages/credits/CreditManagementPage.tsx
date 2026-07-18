import { useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type {
  AccountRole,
  ModelRouteResponse,
  OrganizationCreditView
} from '../../app/types'

interface RateDraft {
  inputCreditPerToken: string
  outputCreditPerToken: string
  multiplier: string
}

export function CreditManagementPage({
  client,
  role,
  views,
  models = [],
  onRefresh
}: {
  readonly client: ManagementApiClient
  readonly role: AccountRole
  readonly views: readonly OrganizationCreditView[]
  readonly models?: ModelRouteResponse['models']
  readonly onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [monthlyDrafts, setMonthlyDrafts] = useState<Record<string, string>>({})
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({})
  const [riskDrafts, setRiskDrafts] = useState<Record<string, {
    maxOverdraftPerTurn: string
    maxCumulativeRisk: string
  }>>({})
  const [rateDrafts, setRateDrafts] = useState<Record<string, RateDraft>>({})

  const run = async (operation: () => Promise<void>, success: string) => {
    setBusy(true)
    setMessage(null)
    try {
      await operation()
      await onRefresh()
      setMessage(success)
    } catch {
      setMessage('保存失败，请检查积分总额、角色权限和输入格式。')
    } finally {
      setBusy(false)
    }
  }

  const rates = views.find(view => view.modelRates)?.modelRates || []

  if (views.length === 0) {
    return (
      <section className="content-card">
        <h2>积分管理</h2>
        <p className="muted">当前没有可管理的组织积分周期。</p>
      </section>
    )
  }

  return (
    <>
      {views.map(view => {
        const risk = riskDrafts[view.organization.id] || {
          maxOverdraftPerTurn:
            view.riskPolicy?.maxOverdraftPerTurn || '0.000000',
          maxCumulativeRisk:
            view.riskPolicy?.maxCumulativeRisk || '0.000000'
        }
        return (
          <section
            className="content-card credit-organization-card"
            key={view.organization.id}
          >
            <header className="credit-card-header">
              <div>
                <h2>{view.organization.name}</h2>
                <p className="muted">
                  {view.period.periodStart} 至 {view.period.periodEnd}
                </p>
              </div>
              <span className="status">本月</span>
            </header>
            <div className="metric-grid">
              <article><span>组织总积分</span><strong>{view.period.allocated}</strong></article>
              <article><span>已结算</span><strong>{view.period.settled}</strong></article>
              <article><span>可用积分</span><strong>{view.period.available}</strong></article>
              <article><span>请求数</span><strong>{view.usage.requests}</strong></article>
            </div>
            {role === 'level1' && (
              <div className="credit-policy-grid">
                <label>
                  组织月度总积分
                  <input
                    aria-label="组织月度总积分"
                    value={monthlyDrafts[view.organization.id] ?? view.period.allocated}
                    onChange={event => setMonthlyDrafts(current => ({
                      ...current,
                      [view.organization.id]: event.target.value
                    }))}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(
                      () => client.setMonthlyCredits(
                        view.organization.id,
                        monthlyDrafts[view.organization.id] ?? view.period.allocated
                      ),
                      '组织月度总积分已更新。'
                    )}
                  >
                    保存月度总积分
                  </button>
                </label>
                <label>
                  单次最大透支积分
                  <input
                    aria-label="单次最大透支积分"
                    value={risk.maxOverdraftPerTurn}
                    onChange={event => setRiskDrafts(current => ({
                      ...current,
                      [view.organization.id]: {
                        ...risk,
                        maxOverdraftPerTurn: event.target.value
                      }
                    }))}
                  />
                </label>
                <label>
                  累计风险上限
                  <input
                    aria-label="累计风险上限"
                    value={risk.maxCumulativeRisk}
                    onChange={event => setRiskDrafts(current => ({
                      ...current,
                      [view.organization.id]: {
                        ...risk,
                        maxCumulativeRisk: event.target.value
                      }
                    }))}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(
                      () => client.setRiskPolicy(view.organization.id, risk),
                      '组织风险策略已更新。'
                    )}
                  >
                    保存风险策略
                  </button>
                </label>
                <article className="risk-occupancy">
                  <span>运行中风险占用</span>
                  <strong>{view.riskPolicy?.activeRiskCredits || '0.000000'}</strong>
                </article>
              </div>
            )}
            <h3>用户积分与实际用量</h3>
            <ul className="item-list credit-user-list">
              {view.users.map(user => (
                <li key={user.accountId}>
                  <div>
                    <strong>{user.display}</strong>
                    <span>
                      已结算 {user.settled} · 可用 {user.available} ·
                      {' '}{user.requests} 次 · {user.inputTokens + user.outputTokens} Token
                    </span>
                  </div>
                  <div className="credit-allocation-control">
                    <input
                      aria-label={`用户积分 ${user.display}`}
                      value={allocationDrafts[user.accountId] ?? user.allocated}
                      onChange={event => setAllocationDrafts(current => ({
                        ...current,
                        [user.accountId]: event.target.value
                      }))}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(
                        () => client.setUserCreditAllocation(
                          user.accountId,
                          allocationDrafts[user.accountId] ?? user.allocated
                        ),
                        '用户积分已更新。'
                      )}
                    >
                      保存用户积分
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {role === 'level1' && (
        <section className="content-card">
          <h2>模型费率</h2>
          <p className="muted">费率、倍率和风险占用仅一级管理员可见。</p>
          {rates.length === 0 ? (
            <p className="muted">当前模型使用系统默认费率，保存模型配置后可建立版本化费率。</p>
          ) : (
            <ul className="item-list model-rate-list">
              {rates.map(rate => {
                const draft = rateDrafts[rate.modelId] || rate
                const route = models.find(item => item.publicModelId === rate.modelId)
                return (
                  <li key={rate.modelId}>
                    <div>
                      <strong>{rate.modelId}</strong>
                      <span>{rate.multiplier}×</span>
                    </div>
                    <div className="rate-controls">
                      <input
                        aria-label={`输入费率 ${rate.modelId}`}
                        value={draft.inputCreditPerToken}
                        onChange={event => setRateDrafts(current => ({
                          ...current,
                          [rate.modelId]: {
                            ...draft,
                            inputCreditPerToken: event.target.value
                          }
                        }))}
                      />
                      <input
                        aria-label={`输出费率 ${rate.modelId}`}
                        value={draft.outputCreditPerToken}
                        onChange={event => setRateDrafts(current => ({
                          ...current,
                          [rate.modelId]: {
                            ...draft,
                            outputCreditPerToken: event.target.value
                          }
                        }))}
                      />
                      <input
                        aria-label={`倍率 ${rate.modelId}`}
                        value={draft.multiplier}
                        onChange={event => setRateDrafts(current => ({
                          ...current,
                          [rate.modelId]: {
                            ...draft,
                            multiplier: event.target.value
                          }
                        }))}
                      />
                      <button
                        type="button"
                        disabled={busy || !route}
                        onClick={() => route && void run(
                          () => client.putModel(rate.modelId, {
                            providerId: route.providerId,
                            upstreamModelId: route.upstreamModelId,
                            priority: route.priority,
                            enabled: route.enabled,
                            ...draft
                          }),
                          '模型费率已更新。'
                        )}
                      >
                        保存模型费率
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
      {message && <p role="status" className="warning">{message}</p>}
    </>
  )
}
