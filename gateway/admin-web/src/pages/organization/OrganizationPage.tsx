import { FormEvent, useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import { accountRoleLabel, accountStatusLabel } from '../../app/labels'
import type {
  AccountRole,
  OrganizationAccountSummary,
  OrganizationSummary
} from '../../app/types'

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
  const [roleDrafts, setRoleDrafts] = useState<Record<string, {
    role: AccountRole
    organizationId: string
  }>>({})

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

  const roleDraft = (account: OrganizationAccountSummary) => roleDrafts[account.id] || {
    role: account.role,
    organizationId: account.organizationId || organizations.find(item => item.status === 'active')?.id || ''
  }

  const resetRoleDraft = (accountId: string) => {
    setRoleDrafts(current => {
      const next = { ...current }
      delete next[accountId]
      return next
    })
  }

  const saveRole = async (account: OrganizationAccountSummary) => {
    const draft = roleDraft(account)
    setBusy(true)
    setMessage(null)
    try {
      await client.setAccountRole(account.id, {
        role: draft.role,
        organizationId: draft.role === 'level1' ? null : draft.organizationId
      })
      await onRefresh()
      resetRoleDraft(account.id)
      setMessage('账号角色和组织归属已更新。')
    } catch {
      resetRoleDraft(account.id)
      setMessage('账号角色更新失败，请检查组织归属和最后一级管理员保护。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="content-card">
        <h2>组织与用户</h2>
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
        {role === 'level1' && (
          <p className="muted">用户先通过组织邀请码注册，再由一级管理员在此任命或撤销管理员角色。</p>
        )}
        {accounts.length === 0 ? <p className="muted">暂无组织用户。</p> : (
          <ul className="item-list">
            {accounts.map(account => (
              <li className="account-list-item" key={account.id}>
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
                {role === 'level1' && (
                  <div className="account-role-controls">
                    <select
                      aria-label={`角色 ${account.email || account.loginName || account.id}`}
                      value={roleDraft(account).role}
                      onChange={event => setRoleDrafts(current => ({
                        ...current,
                        [account.id]: {
                          ...roleDraft(account),
                          role: event.target.value as AccountRole
                        }
                      }))}
                    >
                      <option value="user">普通用户</option>
                      <option value="level2">二级管理员</option>
                      <option value="level1">一级管理员</option>
                    </select>
                    {roleDraft(account).role !== 'level1' && (
                      <select
                        aria-label={`归属组织 ${account.email || account.loginName || account.id}`}
                        value={roleDraft(account).organizationId}
                        onChange={event => setRoleDrafts(current => ({
                          ...current,
                          [account.id]: {
                            ...roleDraft(account),
                            organizationId: event.target.value
                          }
                        }))}
                      >
                        {organizations
                          .filter(organization => organization.status === 'active')
                          .map(organization => (
                            <option key={organization.id} value={organization.id}>
                              {organization.name}
                            </option>
                          ))}
                      </select>
                    )}
                    <button type="button" disabled={busy} onClick={() => void saveRole(account)}>
                      保存角色
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {message && <p role="status" className="warning">{message}</p>}
      </section>
    </>
  )
}
