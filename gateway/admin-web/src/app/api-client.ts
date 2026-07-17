import type {
  AccountDetails,
  DeviceSession,
  ManagementSession,
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
  usage(accountId: string): Promise<UsageResponse>
}

export const managementApi: ManagementApiClient = {
  exchangeTicket: ticket => requestJson('/api/v1/webview/session', {
    method: 'POST',
    body: JSON.stringify({ ticket })
  }),
  account: () => requestJson('/api/v1/account/me'),
  devices: () => requestJson('/api/v1/account/devices'),
  usage: accountId => requestJson(
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/usage`
  )
}
