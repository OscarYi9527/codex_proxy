import type { AccountDetails } from '../../app/types'
import { accountRoleLabel, accountStatusLabel } from '../../app/labels'

export function AccountPage({ details }: { readonly details: AccountDetails }) {
  const display = details.account.email || details.account.loginName || 'AI Editor 账号'
  return (
    <section aria-labelledby="account-title" className="content-card">
      <h2 id="account-title">我的账号</h2>
      <dl className="details-grid">
        <div><dt>账号</dt><dd>{display}</dd></div>
        <div><dt>角色</dt><dd>{accountRoleLabel(details.account.role)}</dd></div>
        <div><dt>状态</dt><dd>{accountStatusLabel(details.account.status)}</dd></div>
        <div>
          <dt>组织</dt>
          <dd>{details.account.organization?.name || '未加入组织'}</dd>
        </div>
      </dl>
      {(details.account.mustChangePassword || details.account.mustProvideEmail) && (
        <p className="warning" role="alert">请先修改临时密码并完善邮箱。</p>
      )}
    </section>
  )
}
