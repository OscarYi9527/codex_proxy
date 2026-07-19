import type { AccountDetails } from '../../app/types'

export function CreditsPage({
  details,
  onOpenOrganizations,
  onOpenCredits
}: {
  readonly details: AccountDetails
  readonly onOpenOrganizations: () => void
  readonly onOpenCredits: () => void
}) {
  if (details.account.role === 'level1') {
    return (
      <section aria-labelledby="credits-title" className="content-card">
        <h2 id="credits-title">额度管理</h2>
        <p className="muted">
          一级管理员账号额度不受限，不参与个人积分、透支或累计风险限制。
          请先创建组织，再为组织设置月度总积分并向组织用户分配额度。
        </p>
        <div className="button-row">
          <button type="button" onClick={onOpenOrganizations}>管理组织与用户</button>
          <button type="button" onClick={onOpenCredits}>分配组织额度</button>
        </div>
      </section>
    )
  }

  const { credits } = details
  return (
    <section aria-labelledby="credits-title" className="content-card">
      <h2 id="credits-title">积分</h2>
      <div className="metric-grid">
        <article><span>可用积分</span><strong>{credits.available}</strong></article>
        <article><span>已分配</span><strong>{credits.allocated}</strong></article>
        <article><span>已结算</span><strong>{credits.settled}</strong></article>
      </div>
      <p className="muted">
        {credits.periodStart && credits.periodEnd
          ? `${credits.periodStart} 至 ${credits.periodEnd}`
          : '当前尚无月度积分周期'}
      </p>
    </section>
  )
}
