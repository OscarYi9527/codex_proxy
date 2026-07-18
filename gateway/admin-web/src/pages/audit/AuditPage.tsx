import { useEffect, useMemo, useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type {
  AccountRole,
  AdminAuditEvent,
  ConversationAuditDetail,
  ConversationAuditSummary,
  OrganizationSummary
} from '../../app/types'

function formatTime(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN')
}

function outcomeLabel(value: AdminAuditEvent['outcome']): string {
  return {
    allowed: '允许',
    denied: '拒绝',
    failed: '失败'
  }[value]
}

export function AuditPage({
  role,
  organizations,
  client
}: {
  readonly role: AccountRole
  readonly organizations: readonly OrganizationSummary[]
  readonly client: ManagementApiClient
}) {
  const initialOrganization = organizations[0]?.id || ''
  const [organizationId, setOrganizationId] = useState(initialOrganization)
  const selectedOrganization = useMemo(
    () => organizations.find(item => item.id === organizationId) || null,
    [organizationId, organizations]
  )
  const [retentionDays, setRetentionDays] = useState(
    selectedOrganization?.auditRetentionDays || 30
  )
  const [conversations, setConversations] =
    useState<readonly ConversationAuditSummary[]>([])
  const [adminEvents, setAdminEvents] = useState<readonly AdminAuditEvent[]>([])
  const [selected, setSelected] = useState<ConversationAuditDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setRetentionDays(selectedOrganization?.auditRetentionDays || 30)
  }, [selectedOrganization])

  useEffect(() => {
    if (role === 'user') return
    let disposed = false
    setLoading(true)
    setError(null)
    const scope = organizationId || undefined
    void Promise.all([
      client.conversationAudits(scope),
      client.adminAuditEvents(scope)
    ]).then(([conversationResponse, adminResponse]) => {
      if (disposed) return
      setConversations(conversationResponse.conversations)
      setAdminEvents(adminResponse.events)
      setLoading(false)
    }).catch(() => {
      if (disposed) return
      setError('调用审计加载失败，请稍后重试。')
      setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [client, organizationId, role])

  if (role === 'user') {
    return (
      <section className="content-card">
        <h2>调用审计</h2>
        <p className="warning">当前账号无权查看组织调用审计。</p>
      </section>
    )
  }

  const openConversation = async (auditId: string) => {
    setError(null)
    try {
      setSelected(await client.conversationAudit(auditId))
    } catch {
      setError('审计正文读取失败或已无权访问。')
    }
  }

  const saveRetention = async () => {
    if (!organizationId) {
      setError('请选择需要设置保留期的组织。')
      return
    }
    if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 180) {
      setError('审计正文保留期必须为 7–180 天。')
      return
    }
    setError(null)
    setNotice(null)
    try {
      await client.setAuditRetention(organizationId, retentionDays)
      setNotice(`正文保留期已更新为 ${retentionDays} 天。`)
    } catch {
      setError('正文保留期更新失败。')
    }
  }

  return (
    <section className="audit-page">
      <header className="audit-hero">
        <div>
          <p className="eyebrow">PRIVACY-SAFE AUDIT</p>
          <h2>调用审计</h2>
          <p>仅保存脱敏用户问题、最终 AI 回复、模型和 Token 用量；不保存文件、系统提示、推理和工具输出。</p>
        </div>
        <div className="audit-summary">
          <div><span>调用记录</span><strong>{conversations.length}</strong></div>
          <div><span>管理事件</span><strong>{adminEvents.length}</strong></div>
        </div>
      </header>

      <section className="content-card audit-toolbar">
        <label>
          组织范围
          <select
            value={organizationId}
            onChange={event => {
              setOrganizationId(event.target.value)
              setSelected(null)
            }}
          >
            {role === 'level1' && <option value="">全部组织</option>}
            {organizations.map(organization => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
        {role === 'level1' && (
          <div className="audit-retention-control">
            <label>
              正文保留天数
              <input
                aria-label="正文保留天数"
                type="number"
                min={7}
                max={180}
                value={retentionDays}
                disabled={!organizationId}
                onChange={event => setRetentionDays(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              disabled={!organizationId}
              onClick={() => void saveRetention()}
            >
              保存保留期
            </button>
          </div>
        )}
      </section>

      {notice && <p role="status" className="provider-notice">{notice}</p>}
      {error && <p role="alert" className="warning">{error}</p>}
      {loading && <section className="content-card"><p>正在加载审计记录…</p></section>}

      {!loading && (
        <section className="content-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CONVERSATIONS</p>
              <h2>AI 调用记录</h2>
            </div>
            <span>列表不返回问答正文，点击后才进行受审计的读取。</span>
          </div>
          {conversations.length ? (
            <div className="audit-table-wrap">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>账号</th>
                    <th>模型</th>
                    <th>Token</th>
                    <th>正文</th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.map(item => (
                    <tr key={item.id}>
                      <td>{formatTime(item.createdAt)}</td>
                      <td>{item.accountId}</td>
                      <td>{item.modelId}</td>
                      <td>{item.inputTokens} / {item.outputTokens}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => void openConversation(item.id)}
                        >
                          {item.bodyDeletedAt ? '正文已清理' : '查看正文'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">当前范围内暂无调用审计。</p>
          )}
        </section>
      )}

      {selected && (
        <section className="content-card audit-detail" role="dialog" aria-label="审计正文">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">AUDIT DETAIL</p>
              <h2>{selected.modelId}</h2>
            </div>
            <button type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          {selected.bodyDeletedAt ? (
            <div className="audit-deleted">
              <strong>正文已按组织保留策略删除</strong>
              <span>清理时间：{formatTime(selected.bodyDeletedAt)}；Token 聚合仍然保留。</span>
            </div>
          ) : (
            <div className="audit-body-grid">
              <article>
                <h3>用户问题（已脱敏）</h3>
                <pre>{selected.userText || '未提取到允许保存的用户文本。'}</pre>
              </article>
              <article>
                <h3>AI 回复（已脱敏）</h3>
                <pre>{selected.assistantText || '未提取到允许保存的最终回复。'}</pre>
              </article>
            </div>
          )}
        </section>
      )}

      {!loading && (
        <section className="content-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ADMIN EVENTS</p>
              <h2>管理员审计</h2>
            </div>
            <span>正文查看、拒绝访问和保留期修改均留下安全事件。</span>
          </div>
          <ul className="admin-audit-list">
            {adminEvents.map(event => (
              <li key={event.id}>
                <div>
                  <strong>{event.action}</strong>
                  <span>{event.actorAccountId} · {formatTime(event.createdAt)}</span>
                </div>
                <span className={`audit-outcome ${event.outcome}`}>
                  {outcomeLabel(event.outcome)}
                </span>
              </li>
            ))}
          </ul>
          {!adminEvents.length && <p className="muted">当前范围内暂无管理员审计。</p>}
        </section>
      )}
    </section>
  )
}
