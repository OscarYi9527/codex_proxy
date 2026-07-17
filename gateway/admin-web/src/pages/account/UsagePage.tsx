import type { UsageResponse } from '../../app/types'

export function UsagePage({ usage }: { readonly usage: UsageResponse }) {
  return (
    <section aria-labelledby="usage-title" className="content-card">
      <h2 id="usage-title">使用记录</h2>
      <div className="metric-grid">
        <article><span>请求数</span><strong>{usage.summary.requests}</strong></article>
        <article><span>输入 Token</span><strong>{usage.summary.inputTokens}</strong></article>
        <article><span>输出 Token</span><strong>{usage.summary.outputTokens}</strong></article>
      </div>
      {usage.records.length === 0 ? (
        <p className="muted">暂无已结算的使用记录。</p>
      ) : (
        <ul className="item-list">
          {usage.records.map(record => (
            <li key={record.id}>
              <div>
                <strong>{record.modelId}</strong>
                <span>{record.completedAt}</span>
              </div>
              <span>{record.totalCredits} 积分</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
