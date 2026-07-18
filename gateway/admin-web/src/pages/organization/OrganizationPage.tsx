import { FormEvent, useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type {
  AccountRole,
  OrganizationAccountSummary,
  OrganizationSummary
} from '../../app/types'

function accountRoleLabel(role: AccountRole): string {
  return {
    level1: '一级管理员',
    level2: '二级管理员',
    user: '普通用户'
  }[role]
}

function accountStatusLabel(status: OrganizationAccountSummary['status']): string {
  return {
    active: '已启用',
    disabled: '已禁用',
    expired: '已过期'
  }[status]
}

export function OrganizationPage({
  client,
  role,
  organizations,
  accounts,
  onRefresh
}: {
  readonly client: ManagementApiClient
  readonly role: AccountRole
  readonly organizations: readonly OrganizationSummary[]
  readonly accounts: readonly OrganizationAccountSummary[]
  readonly onRefresh: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await client.createOrganization(name)
      setName('')
      await onRefresh()
      setMessage('组织已创建。')
    } catch {
      setMessage('创建组织失败，请检查名称是否重复。')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (account: OrganizationAccountSummary) => {
    setBusy(true)
    setMessage(null)
    try {
      await client.setAccountStatus(account.id, account.status === 'active' ? 'disabled' : 'active')
      await onRefresh()
      setMessage('账号状态已更新。')
    } catch {
      setMessage('账号状态更新失败，可能超出当前管理员权限。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="content-card">
        <h2>组织</h2>
        {role === 'level1' && (
          <form className="security-form" onSubmit={event => void create(event)}>
            <label>
              组织名称
              <input required value={name} onChange={event => setName(event.target.value)} />
            </label>
            <button type="submit" disabled={busy}>创建组织</button>
          </form>
        )}
        <ul className="item-list">
          {organizations.map(organization => (
            <li key={organization.id}>
              <div><strong>{organization.name}</strong><span>{organization.id}</span></div>
              <span className="status">{organization.status === 'active' ? '已启用' : '已禁用'}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="content-card">
        <h2>组织用户</h2>
        {accounts.length === 0 ? <p className="muted">暂无组织用户。</p> : (
          <ul className="item-list">
            {accounts.map(account => (
              <li key={account.id}>
                <div>
                  <strong>{account.email || account.loginName || account.id}</strong>
                  <span>{accountRoleLabel(account.role)} · {account.organizationId || '未分配组织'}</span>
                </div>
                <div className="button-row">
                  <span className="status">{accountStatusLabel(account.status)}</span>
                  {(role === 'level1' || account.role === 'user') && account.status !== 'expired' && (
                    <button type="button" disabled={busy} onClick={() => void toggle(account)}>
                      {account.status === 'active' ? '禁用' : '启用'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && <p role="status" className="warning">{message}</p>}
      </section>
    </>
  )
}
