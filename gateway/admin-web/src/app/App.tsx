import { useEffect, useMemo, useRef, useState } from 'react'
import { AccountPage } from '../pages/account/AccountPage'
import { CreditsPage } from '../pages/account/CreditsPage'
import { SecurityPage } from '../pages/account/SecurityPage'
import { UsagePage } from '../pages/account/UsagePage'
import { InvitationsPage } from '../pages/organization/InvitationsPage'
import { OrganizationPage } from '../pages/organization/OrganizationPage'
import { CreditManagementPage } from '../pages/credits/CreditManagementPage'
import { DiagnosticsPage } from '../pages/system/DiagnosticsPage'
import { ProvidersPage } from '../pages/system/ProvidersPage'
import { managementApi, type ManagementApiClient } from './api-client'
import { managementBootstrapFromEvent } from './bootstrap'
import { accountRoleLabel } from './labels'
import type {
  AccountDetails,
  DeviceSession,
  ManagementRoute,
  ManagementSession,
  InvitationSummary,
  ModelRouteResponse,
  OrganizationAccountSummary,
  OrganizationCreditView,
  OrganizationSummary,
  ProviderDiagnostics,
  ProviderListResponse,
  UsageResponse
} from './types'

interface LoadedManagementData {
  readonly session: ManagementSession
  readonly account: AccountDetails
  readonly devices: readonly DeviceSession[]
  readonly usage: UsageResponse
  readonly organizations: readonly OrganizationSummary[]
  readonly organizationAccounts: readonly OrganizationAccountSummary[]
  readonly invitations: readonly InvitationSummary[]
  readonly creditViews: readonly OrganizationCreditView[]
  readonly providers: ProviderListResponse | null
  readonly models: ModelRouteResponse | null
  readonly diagnostics: ProviderDiagnostics | null
}

function PlaceholderPage({ route }: { readonly route: ManagementRoute }) {
  const labels: Partial<Record<ManagementRoute, string>> = {
    organization: '组织用户',
    invitations: '邀请码',
    providers: 'Provider 与模型',
    diagnostics: '系统诊断',
    credits: '积分管理'
  }
  return (
    <section className="content-card">
      <h2>{labels[route] || 'AI Editor 管理'}</h2>
      <p className="muted">此角色页面将在对应管理阶段启用。</p>
    </section>
  )
}

export function App({
  client = managementApi,
  expectedOrigin = window.location.origin
}: {
  readonly client?: ManagementApiClient
  readonly expectedOrigin?: string
}) {
  const bootstrapping = useRef(false)
  const [data, setData] = useState<LoadedManagementData | null>(null)
  const [route, setRoute] = useState<ManagementRoute>('account')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (bootstrapping.current || data) return
      const bootstrap = managementBootstrapFromEvent(event, expectedOrigin)
      if (!bootstrap) return
      bootstrapping.current = true
      void (async () => {
        try {
          const session = await client.exchangeTicket(bootstrap.ticket)
          const permitted = new Set(session.navigation.map(item => item.id))
          const initialRoute = permitted.has(bootstrap.route) ? bootstrap.route : 'account'
          const [account, devices, usage] = await Promise.all([
            client.account(),
            client.devices(),
            client.usage(session.account.id)
          ])
          const [organizations, organizationAccounts, invitations] =
            session.account.role === 'user'
              ? [[], [], []]
              : await Promise.all([
                  client.organizations(),
                  client.organizationAccounts(),
                  client.invitations()
                ])
          const creditViews = session.account.role === 'user'
            ? []
            : await Promise.all(
                organizations.map(organization =>
                  client.organizationCredits(organization.id)
                )
              )
          const [providers, models, diagnostics] = session.account.role === 'level1'
            ? await Promise.all([
                client.providers(),
                client.models(),
                client.diagnostics()
              ])
            : [null, null, null]
          setRoute(initialRoute)
          setData({
            session,
            account,
            devices,
            usage,
            organizations,
            organizationAccounts,
            invitations,
            creditViews,
            providers,
            models,
            diagnostics
          })
          setError(null)
        } catch {
          bootstrapping.current = false
          setError('管理会话建立失败，请关闭标签页后重试。')
        }
      })()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [client, data, expectedOrigin])

  const allowedRoutes = useMemo(
    () => new Set(data?.session.navigation.map(item => item.id) || []),
    [data]
  )

  if (!data) {
    return (
      <main className="bootstrap-shell">
        <p className="eyebrow">AI EDITOR GATEWAY</p>
        <h1>AI Editor 管理</h1>
        {error ? (
          <p role="alert" className="warning">{error}</p>
        ) : (
          <p>正在等待 Code 建立安全管理会话…</p>
        )}
      </main>
    )
  }

  const selectRoute = (candidate: ManagementRoute) => {
    if (allowedRoutes.has(candidate)) setRoute(candidate)
  }

  const refreshProviderData = async () => {
    if (data.session.account.role !== 'level1') return
    const [providers, models, diagnostics] = await Promise.all([
      client.providers(),
      client.models(),
      client.diagnostics()
    ])
    setData(current => current
      ? { ...current, providers, models, diagnostics }
      : current)
  }

  const refreshDevices = async () => {
    const devices = await client.devices()
    setData(current => current ? { ...current, devices } : current)
  }

  const refreshOrganizationData = async () => {
    if (data.session.account.role === 'user') return
    const [organizations, organizationAccounts, invitations] = await Promise.all([
      client.organizations(),
      client.organizationAccounts(),
      client.invitations()
    ])
    const creditViews = await Promise.all(
      organizations.map(organization => client.organizationCredits(organization.id))
    )
    setData(current => current
      ? {
          ...current,
          organizations,
          organizationAccounts,
          invitations,
          creditViews
        }
      : current)
  }

  return (
    <div className="management-layout">
      <aside>
        <p className="eyebrow">AI EDITOR</p>
        <h1>管理</h1>
        <nav aria-label="管理导航">
          {data.session.navigation.map(item => (
            <button
              key={item.id}
              type="button"
              aria-current={route === item.id ? 'page' : undefined}
              onClick={() => selectRoute(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <p className="session-note">管理会话将在短时间无操作后失效。</p>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">安全账号中心</p>
            <h1>AI Editor 管理</h1>
          </div>
          <span className="role-badge">{accountRoleLabel(data.session.account.role)}</span>
        </header>
        {route === 'account' && (
          <>
            <AccountPage details={data.account} />
            <CreditsPage credits={data.account.credits} />
          </>
        )}
        {route === 'security' && (
          <SecurityPage
            client={client}
            details={data.account}
            devices={data.devices}
            onDevicesChanged={refreshDevices}
          />
        )}
        {route === 'usage' && <UsagePage usage={data.usage} />}
        {route === 'organization' && (
          <OrganizationPage
            client={client}
            role={data.session.account.role}
            organizations={data.organizations}
            accounts={data.organizationAccounts}
            onRefresh={refreshOrganizationData}
          />
        )}
        {route === 'invitations' && (
          <InvitationsPage
            client={client}
            role={data.session.account.role}
            organizations={data.organizations}
            invitations={data.invitations}
            onRefresh={refreshOrganizationData}
          />
        )}
        {route === 'credits' && (
          <CreditManagementPage
            client={client}
            role={data.session.account.role}
            views={data.creditViews}
            models={data.models?.models}
            onRefresh={refreshOrganizationData}
          />
        )}
        {route === 'providers' && data.providers && data.models && (
          <ProvidersPage
            client={client}
            providers={data.providers}
            models={data.models}
            onRefresh={refreshProviderData}
          />
        )}
        {route === 'diagnostics' && data.diagnostics && (
          <DiagnosticsPage diagnostics={data.diagnostics} />
        )}
        {!['account', 'security', 'usage', 'organization', 'invitations', 'credits', 'providers', 'diagnostics'].includes(route) && (
          <PlaceholderPage route={route} />
        )}
      </main>
    </div>
  )
}
