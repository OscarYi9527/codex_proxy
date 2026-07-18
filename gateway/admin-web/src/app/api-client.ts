import type {
  AccountDetails,
  ChatgptLoginStatus,
  DeviceSession,
  ManagementSession,
  ModelRouteResponse,
  InvitationCreation,
  InvitationSummary,
  OrganizationAccountSummary,
  OrganizationSummary,
  ProviderDiagnostics,
  ProviderListResponse,
  ProviderSummary,
  UsageResponse
} from './types'

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  })
  if (!response.ok) throw new Error(`management_request_failed_${response.status}`)
  return response.json() as Promise<T>
}

export interface ManagementApiClient {
  exchangeTicket(ticket: string): Promise<ManagementSession>
  account(): Promise<AccountDetails>
  devices(): Promise<readonly DeviceSession[]>
  changePassword(input: {
    currentPassword: string
    newPassword: string
    email?: string
  }): Promise<void>
  revokeDevice(deviceSessionId: string, confirmCurrent: boolean): Promise<void>
  usage(accountId: string): Promise<UsageResponse>
  organizations(): Promise<readonly OrganizationSummary[]>
  createOrganization(name: string): Promise<OrganizationSummary>
  organizationAccounts(): Promise<readonly OrganizationAccountSummary[]>
  setAccountStatus(accountId: string, status: 'active' | 'disabled'): Promise<void>
  setAccountRole(accountId: string, input: {
    role: OrganizationAccountSummary['role']
    organizationId: string | null
  }): Promise<OrganizationAccountSummary>
  invitations(): Promise<readonly InvitationSummary[]>
  createInvitation(input: {
    organizationId: string
    expiresAt: string
    maxUses: number
  }): Promise<InvitationCreation>
  revokeInvitation(invitationId: string): Promise<void>
  providers(): Promise<ProviderListResponse>
  createProvider(input: {
    kind: ProviderSummary['kind']
    displayName: string
    config: { baseUrl?: string; models: string[] }
  }): Promise<ProviderSummary>
  updateProvider(
    providerId: string,
    input: { status?: ProviderSummary['status']; displayName?: string }
  ): Promise<ProviderSummary>
  deleteProvider(providerId: string): Promise<void>
  addProviderCredential(providerId: string, secret: string): Promise<void>
  deleteProviderCredential(providerId: string, credentialId: string): Promise<void>
  startChatgptLogin(providerId: string): Promise<ChatgptLoginStatus>
  chatgptLoginStatus(providerId: string): Promise<ChatgptLoginStatus>
  models(): Promise<ModelRouteResponse>
  putModel(
    publicModelId: string,
    input: {
      providerId: string
      upstreamModelId: string
      priority: number
      enabled: boolean
    }
  ): Promise<void>
  diagnostics(): Promise<ProviderDiagnostics>
}

async function requestVoid(path: string, options: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  })
  if (!response.ok) throw new Error(`management_request_failed_${response.status}`)
}

export const managementApi: ManagementApiClient = {
  exchangeTicket: ticket => requestJson('/api/v1/webview/session', {
    method: 'POST',
    body: JSON.stringify({ ticket })
  }),
  account: () => requestJson('/api/v1/account/me'),
  devices: () => requestJson('/api/v1/account/devices'),
  changePassword: input => requestVoid('/api/v1/account/password/change', {
    method: 'POST',
    body: JSON.stringify(input)
  }),
  revokeDevice: (deviceSessionId, confirmCurrent) =>
    requestVoid(
      `/api/v1/account/devices/${encodeURIComponent(deviceSessionId)}` +
        `?confirmCurrent=${confirmCurrent ? 'true' : 'false'}`,
      { method: 'DELETE' }
    ),
  usage: accountId => requestJson(
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/usage`
  ),
  organizations: () => requestJson('/api/v1/admin/organizations'),
  createOrganization: name => requestJson('/api/v1/admin/organizations', {
    method: 'POST',
    body: JSON.stringify({ name })
  }),
  organizationAccounts: () => requestJson('/api/v1/admin/accounts'),
  setAccountStatus: (accountId, status) =>
    requestVoid(
      `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/${status === 'active' ? 'enable' : 'disable'}`,
      { method: 'POST' }
    ),
  setAccountRole: (accountId, input) =>
    requestJson(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/role`, {
      method: 'PUT',
      body: JSON.stringify(input)
    }),
  invitations: () => requestJson('/api/v1/admin/invitations'),
  createInvitation: input => requestJson('/api/v1/admin/invitations', {
    method: 'POST',
    body: JSON.stringify(input)
  }),
  revokeInvitation: invitationId =>
    requestVoid(`/api/v1/admin/invitations/${encodeURIComponent(invitationId)}/revoke`, {
      method: 'POST'
    }),
  providers: () => requestJson('/api/v1/admin/providers'),
  createProvider: input => requestJson('/api/v1/admin/providers', {
    method: 'POST',
    body: JSON.stringify(input)
  }),
  updateProvider: (providerId, input) =>
    requestJson(`/api/v1/admin/providers/${encodeURIComponent(providerId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    }),
  deleteProvider: providerId =>
    requestVoid(`/api/v1/admin/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE'
    }),
  addProviderCredential: (providerId, secret) =>
    requestVoid(`/api/v1/admin/providers/${encodeURIComponent(providerId)}/credentials`, {
      method: 'POST',
      body: JSON.stringify({ secret })
    }),
  deleteProviderCredential: (providerId, credentialId) =>
    requestVoid(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/credentials/` +
        encodeURIComponent(credentialId),
      { method: 'DELETE' }
    ),
  startChatgptLogin: providerId =>
    requestJson(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/chatgpt-login/start`,
      { method: 'POST' }
    ),
  chatgptLoginStatus: providerId =>
    requestJson(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/chatgpt-login/status`
    ),
  models: () => requestJson('/api/v1/admin/models'),
  putModel: (publicModelId, input) =>
    requestVoid(`/api/v1/admin/models/${encodeURIComponent(publicModelId)}`, {
      method: 'PUT',
      body: JSON.stringify(input)
    }),
  diagnostics: () => requestJson('/api/v1/admin/diagnostics')
}
