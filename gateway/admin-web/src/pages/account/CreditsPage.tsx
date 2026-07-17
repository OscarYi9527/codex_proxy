import type { AccountDetails } from '../../app/types'

export function CreditsPage({ credits }: { readonly credits: AccountDetails['credits'] }) {
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
