import { FormEvent, useState } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type { AccountDetails, DeviceSession } from '../../app/types'

export function SecurityPage({
  client,
  details,
  devices,
  onDevicesChanged
}: {
  readonly client: ManagementApiClient
  readonly details: AccountDetails
  readonly devices: readonly DeviceSession[]
  readonly onDevicesChanged: () => Promise<void>
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [email, setEmail] = useState(details.account.email || '')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submitPasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await client.changePassword({
        currentPassword,
        newPassword,
        ...(email.trim() ? { email: email.trim() } : {})
      })
      setCurrentPassword('')
      setNewPassword('')
      setMessage('密码已更新。为保护设备会话，请关闭此页面并重新登录 AI Editor。')
    } catch {
      setMessage('密码更新失败。请检查当前密码、新密码规则和邮箱后重试。')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (device: DeviceSession) => {
    if (device.current && !window.confirm('撤销当前设备会使本机退出登录。是否继续？')) return
    setBusy(true)
    setMessage(null)
    try {
      await client.revokeDevice(device.id, device.current)
      await onDevicesChanged()
      setMessage(device.current
        ? '当前设备已撤销。请重新登录 AI Editor。'
        : '设备会话已撤销。')
    } catch {
      setMessage('撤销设备失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section aria-labelledby="password-title" className="content-card">
        <h2 id="password-title">修改密码</h2>
        <p className="muted">新密码至少 12 位，并同时包含大写字母、小写字母和数字。</p>
        <form className="security-form" onSubmit={event => void submitPasswordChange(event)}>
          <label>
            当前密码
            <input
              required
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              required
              minLength={12}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
            />
          </label>
          <label>
            邮箱
            <input
              required={details.account.mustProvideEmail}
              type="email"
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>保存新密码</button>
        </form>
      </section>
      <section aria-labelledby="devices-title" className="content-card">
        <h2 id="devices-title">设备与安全</h2>
        {devices.length === 0 ? (
          <p className="muted">暂无设备会话。</p>
        ) : (
          <ul className="item-list">
            {devices.map(device => (
              <li key={device.id}>
                <div>
                  <strong>{device.name}</strong>
                  <span>{device.platform} · 最近使用 {device.lastUsedAt}</span>
                </div>
                <div className="button-row">
                  <span className={device.current ? 'status current' : 'status'}>
                    {device.current ? '当前设备' : device.revokedAt ? '已撤销' : '有效'}
                  </span>
                  {device.revokedAt === null && (
                    <button
                      className="danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void revoke(device)}
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
      {message && <p className="warning" role="status">{message}</p>}
    </>
  )
}
