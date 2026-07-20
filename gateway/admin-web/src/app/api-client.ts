import type {
  AccountRoutingStrategy,
  AccountDetails,
  AdminAuditEventListResponse,
  ChatgptAccountImportResult,
  ChatgptAccountLoginStatus,
  ChatgptLoginStatus,
  ConversationAuditDetail,
  ConversationAuditListResponse,
  DeviceSession,
  ManagementSession,
  ModelRouteResponse,
  InvitationCreation,
  InvitationSummary,
  OrganizationAccountSummary,
  OrganizationCreditView,
  OrganizationSummary,
  PublicMvpCapacity,
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
  publicMvpCapacity(): Promise<PublicMvpCapacity>
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
  organizationCredits(organizationId: string): Promise<OrganizationCreditView>
  setMonthlyCredits(organizationId: string, allocatedCredits: string): Promise<void>
  setUserCreditAllocation(accountId: string, allocatedCredits: string): Promise<void>
  setRiskPolicy(organizationId: string, input: {
    maxOverdraftPerTurn: string
    maxCumulativeRisk: string
  }): Promise<void>
  conversationAudits(organizationId?: string): Promise<ConversationAuditListResponse>
  conversationAudit(auditId: string): Promise<ConversationAuditDetail>
  adminAuditEvents(organizationId?: string): Promise<AdminAuditEventListResponse>
  setAuditRetention(organizationId: string, days: number): Promise<void>
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
  importChatgptAccount(input: {
    authJson: string
    label: string
    routingEnabled: boolean
  }): Promise<ChatgptAccountImportResult>
  startChatgptAccountLogin(input: {
    label: string
    routingEnabled: boolean
  }): Promise<ChatgptAccountLoginStatus>
  chatgptAccountLoginStatus(): Promise<ChatgptAccountLoginStatus>
  deleteProviderCredential(providerId: string, credentialId: string): Promise<void>
  updateProviderCredentialRouting(
    providerId: string,
    credentialId: string,
    input: {
      label: string
      routingEnabled: boolean
      routingWeight: number
      lowQuotaThreshold: number
      dailyRequestLimit: number
      dailyTokenLimit: number
      reservedModels: readonly string[]
    }
  ): Promise<void>
  refreshProviderCredentialUsage(providerId: string, credentialId: string): Promise<void>
  setProviderAccountStrategy(
    providerId: string,
    strategy: AccountRoutingStrategy
  ): Promise<void>
  setProviderInternalBudget(
    providerId: string,
    internalBudgetCredits: string | null
  ): Promise<void>
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
      inputCreditPerToken?: string
      outputCreditPerToken?: string
      multiplier?: string
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
  publicMvpCapacity: () => requestJson('/api/v1/admin/capacity'),
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
  organizationCredits: organizationId => requestJson(
    `/api/v1/admin/organizations/${encodeURIComponent(organizationId)}/credit-periods/current`
  ),
  setMonthlyCredits: (organizationId, allocatedCredits) =>
    requestVoid(
      `/api/v1/admin/organizations/${encodeURIComponent(organizationId)}/monthly-credits`,
      {
        method: 'PUT',
        body: JSON.stringify({ allocatedCredits })
      }
    ),
  setUserCreditAllocation: (accountId, allocatedCredits) =>
    requestVoid(
      `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/credit-allocation`,
      {
        method: 'PUT',
        body: JSON.stringify({ allocatedCredits })
      }
    ),
  setRiskPolicy: (organizationId, input) =>
    requestVoid(
      `/api/v1/admin/organizations/${encodeURIComponent(organizationId)}/risk-policy`,
      {
        method: 'PUT',
        body: JSON.stringify(input)
      }
    ),
  conversationAudits: organizationId =>
    requestJson(
      '/api/v1/admin/audit/conversations' +
        (organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '')
    ),
  conversationAudit: auditId =>
    requestJson(`/api/v1/admin/audit/conversations/${encodeURIComponent(auditId)}`),
  adminAuditEvents: organizationId =>
    requestJson(
      '/api/v1/admin/audit/admin-events' +
        (organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '')
    ),
  setAuditRetention: (organizationId, days) =>
    requestVoid(
      `/api/v1/admin/organizations/${encodeURIComponent(organizationId)}/audit-retention`,
      {
        method: 'PUT',
        body: JSON.stringify({ days })
      }
    ),
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
  importChatgptAccount: input =>
    requestJson('/api/v1/admin/chatgpt-accounts/import', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  startChatgptAccountLogin: input =>
    requestJson('/api/v1/admin/chatgpt-accounts/login/start', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  chatgptAccountLoginStatus: () =>
    requestJson('/api/v1/admin/chatgpt-accounts/login/status'),
  deleteProviderCredential: (providerId, credentialId) =>
    requestVoid(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/credentials/` +
        encodeURIComponent(credentialId),
      { method: 'DELETE' }
    ),
  updateProviderCredentialRouting: (providerId, credentialId, input) =>
    requestVoid(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/credentials/` +
        `${encodeURIComponent(credentialId)}/routing`,
      {
        method: 'PATCH',
        body: JSON.stringify(input)
      }
    ),
  refreshProviderCredentialUsage: (providerId, credentialId) =>
    requestVoid(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/credentials/` +
        `${encodeURIComponent(credentialId)}/refresh-usage`,
      { method: 'POST' }
    ),
  setProviderAccountStrategy: (providerId, strategy) =>
    requestVoid(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/account-routing-strategy`,
      {
        method: 'PUT',
        body: JSON.stringify({ strategy })
      }
    ),
  setProviderInternalBudget: (providerId, internalBudgetCredits) =>
    requestVoid(
      `/api/v1/admin/providers/${encodeURIComponent(providerId)}/internal-budget`,
      {
        method: 'PUT',
        body: JSON.stringify({ internalBudgetCredits })
      }
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
