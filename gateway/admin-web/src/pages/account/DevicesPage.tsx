import type { DeviceSession } from '../../app/types'

export function DevicesPage({ devices }: { readonly devices: readonly DeviceSession[] }) {
  return (
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
              <span className={device.current ? 'status current' : 'status'}>
                {device.current ? '当前设备' : device.revokedAt ? '已撤销' : '有效'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
