import { FormEvent, useMemo, useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type { AccountRole, InvitationSummary, OrganizationSummary } from '../../app/types'

export function InvitationsPage({
  client,
  role,
  organizations,
  invitations,
  onRefresh
}: {
  readonly client: ManagementApiClient
  readonly role: AccountRole
  readonly organizations: readonly OrganizationSummary[]
  readonly invitations: readonly InvitationSummary[]
  readonly onRefresh: () => Promise<void>
}) {
  const defaultOrganization = organizations[0]?.id || ''
  const [organizationId, setOrganizationId] = useState(defaultOrganization)
  const [expiresAt, setExpiresAt] = useState('')
  const [maxUses, setMaxUses] = useState(1)
  const [createdCode, setCreatedCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const availableOrganizations = useMemo(() => organizations.filter(item => item.status === 'active'), [organizations])
  const organizationNames = useMemo(
    () => new Map(organizations.map(item => [item.id, item.name])),
    [organizations]
  )

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setCreatedCode(null)
    setMessage(null)
    try {
      const created = await client.createInvitation({ organizationId, expiresAt, maxUses })
      setCreatedCode(created.code)
      await onRefresh()
    } catch {
      setMessage('邀请码生成失败，请检查组织、AI 权限截止时间和当前账号权限。')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (invitationId: string) => {
    setBusy(true)
    setMessage(null)
    try {
      await client.revokeInvitation(invitationId)
      await onRefresh()
      setMessage('邀请码已撤销。')
    } catch {
      setMessage('邀请码撤销失败，可能已经失效或超出当前账号权限。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="content-card">
      <h2>邀请码</h2>
      <form className="security-form" onSubmit={event => void create(event)}>
        <label>
          组织
          <select
            value={organizationId}
            disabled={role === 'level2'}
            onChange={event => setOrganizationId(event.target.value)}
          >
            {availableOrganizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          AI 权限截止时间
          <input required type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} />
        </label>
        <p className="form-help">
          用户须在该时间前完成注册；注册账号的 AI 使用权限也将在该时间到期。
        </p>
        <label>
          可使用次数
          <input required type="number" min={1} max={10000} value={maxUses} onChange={event => setMaxUses(Number(event.target.value))} />
        </label>
        <button type="submit" disabled={busy || !organizationId}>生成邀请码</button>
      </form>
      {createdCode && (
        <p role="alert" className="warning">
          邀请码只显示一次：<strong>{createdCode}</strong>。账号 AI 权限截止到 {expiresAt}。
        </p>
      )}
      {message && <p role="status" className="warning">{message}</p>}
      {invitations.length === 0 ? <p className="muted">暂无邀请码。</p> : (
        <ul className="item-list">
          {invitations.map(invitation => (
            <li key={invitation.id}>
              <div>
                <strong>{organizationNames.get(invitation.organizationId) || invitation.organizationId}</strong>
                <span>
                  {invitation.useCount}/{invitation.maxUses} · AI 权限截止 {invitation.expiresAt}
                </span>
              </div>
              <div className="button-row">
                <span className="status">{{
                  active: '有效',
                  revoked: '已撤销',
                  exhausted: '已用尽',
                  expired: '已过期'
                }[invitation.status]}</span>
                {invitation.status === 'active' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(invitation.id)}
                  >
                    撤销
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
