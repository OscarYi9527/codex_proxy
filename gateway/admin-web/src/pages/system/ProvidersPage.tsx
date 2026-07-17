import { useState, type FormEvent } from 'react'
import type { ManagementApiClient } from '../../app/api-client'
import type {
  ChatgptLoginStatus,
  ModelRouteResponse,
  ProviderListResponse,
  ProviderSummary
} from '../../app/types'

export function ProvidersPage({
  client,
  providers,
  models,
  onRefresh
}: {
  readonly client: ManagementApiClient
  readonly providers: ProviderListResponse
  readonly models: ModelRouteResponse
  readonly onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loginStatus, setLoginStatus] =
    useState<Readonly<Record<string, ChatgptLoginStatus>>>({})

  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await operation()
      await onRefresh()
    } catch {
      setError('Provider 操作失败，请检查配置和权限。')
    } finally {
      setBusy(false)
    }
  }

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const kind = String(values.get('kind')) as ProviderSummary['kind']
    const baseUrl = String(values.get('baseUrl') || '').trim()
    const models = String(values.get('models') || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    void run(async () => {
      await client.createProvider({
        kind,
        displayName: String(values.get('displayName') || ''),
        config: { ...(baseUrl ? { baseUrl } : {}), models }
      })
      form.reset()
    })
  }

  const credential = (event: FormEvent<HTMLFormElement>, providerId: string) => {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.namedItem('secret') as HTMLInputElement | null
    const secret = input?.value || ''
    if (input) input.value = ''
    void run(() => client.addProviderCredential(providerId, secret))
  }

  const officialLogin = async (providerId: string, refresh = false) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const status = refresh
        ? await client.chatgptLoginStatus(providerId)
        : await client.startChatgptLogin(providerId)
      setLoginStatus(current => ({ ...current, [providerId]: status }))
      if (status.status === 'success') await onRefresh()
    } catch {
      setError('OpenAI 官方登录启动失败，请检查 Codex CLI 和管理员权限。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="content-card" aria-labelledby="providers-title">
        <h2 id="providers-title">Provider 与模型</h2>
        {providers.warning && <p className="warning" role="alert">{providers.warning}</p>}
        {error && <p className="warning" role="alert">{error}</p>}
        <form className="provider-form" onSubmit={create}>
          <label>类型
            <select name="kind" defaultValue="relay">
              <option value="chatgpt">ChatGPT 订阅</option>
              <option value="openai">OpenAI API</option>
              <option value="deepseek">DeepSeek</option>
              <option value="relay">Relay</option>
            </select>
          </label>
          <label>名称<input name="displayName" required maxLength={240} /></label>
          <label>Base URL<input name="baseUrl" placeholder="https://..." /></label>
          <label>模型（逗号分隔）<input name="models" placeholder="gpt-5.4-mini" /></label>
          <button type="submit" disabled={busy}>新增 Provider</button>
        </form>
      </section>

      <section className="content-card" aria-label="Provider 列表">
        {providers.providers.length === 0 ? (
          <p className="muted">尚未配置 Provider。</p>
        ) : providers.providers.map(provider => (
          <article className="provider-card" key={provider.id}>
            <header>
              <div>
                <strong>{provider.displayName}</strong>
                <span>{provider.kind} · {provider.status}</span>
              </div>
              <div className="button-row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => client.updateProvider(provider.id, {
                    status: provider.status === 'active' ? 'disabled' : 'active'
                  }))}
                >
                  {provider.status === 'active' ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => client.deleteProvider(provider.id))}
                >
                  删除
                </button>
              </div>
            </header>
            <p className="muted">{provider.config.baseUrl || '使用默认上游地址'}</p>
            {provider.kind === 'chatgpt' && (
              <div className="official-login">
                <div className="button-row">
                  <button
                    type="button"
                    disabled={busy || loginStatus[provider.id]?.status === 'waiting'}
                    onClick={() => void officialLogin(provider.id)}
                  >
                    OpenAI 官方登录
                  </button>
                  {loginStatus[provider.id] && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void officialLogin(provider.id, true)}
                    >
                      刷新登录状态
                    </button>
                  )}
                </div>
                {loginStatus[provider.id]?.message && (
                  <p className="muted">{loginStatus[provider.id]?.message}</p>
                )}
                {loginStatus[provider.id]?.verificationUrl && (
                  <a
                    href={loginStatus[provider.id]?.verificationUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    在浏览器中打开 OpenAI 登录
                  </a>
                )}
              </div>
            )}
            <ul className="credential-list">
              {provider.credentials.map(item => (
                <li key={item.id}>
                  <span>{item.maskedPreview} · {item.storageFormat}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() =>
                      client.deleteProviderCredential(provider.id, item.id)
                    )}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
            <form className="credential-form" onSubmit={event => credential(event, provider.id)}>
              <label>新凭据
                <input name="secret" type="password" required autoComplete="off" />
              </label>
              <button type="submit" disabled={busy}>保存凭据</button>
            </form>
          </article>
        ))}
      </section>

      <section className="content-card" aria-labelledby="routes-title">
        <h2 id="routes-title">模型路由</h2>
        {models.models.length === 0 ? (
          <p className="muted">暂无模型路由。</p>
        ) : (
          <ul className="item-list">
            {models.models.map(model => (
              <li key={model.id}>
                <div>
                  <strong>{model.publicModelId}</strong>
                  <span>{model.upstreamModelId} · 优先级 {model.priority}</span>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => client.putModel(model.publicModelId, {
                    providerId: model.providerId,
                    upstreamModelId: model.upstreamModelId,
                    priority: model.priority,
                    enabled: !model.enabled
                  }))}
                >
                  {model.enabled ? '停用路由' : '启用路由'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
