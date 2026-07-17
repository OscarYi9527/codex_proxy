export type AccountRole = 'level1' | 'level2' | 'user'

export type ManagementRoute =
  | 'account'
  | 'security'
  | 'organization'
  | 'invitations'
  | 'usage'
  | 'providers'
  | 'diagnostics'

export interface ManagementBootstrapMessage {
  readonly type: 'ai-editor-management-bootstrap'
  readonly version: 1
  readonly route: ManagementRoute
  readonly ticket: string
  readonly expiresIn: number
}

export interface ManagementSession {
  readonly expiresIn: number
  readonly account: {
    readonly id: string
    readonly role: AccountRole
  }
  readonly navigation: ReadonlyArray<{
    readonly id: ManagementRoute
    readonly label: string
  }>
}

export interface AccountDetails {
  readonly account: {
    readonly id: string
    readonly email: string | null
    readonly loginName: string | null
    readonly role: AccountRole
    readonly status: string
    readonly expiresAt: string | null
    readonly organization: { readonly id: string; readonly name: string } | null
    readonly mustChangePassword: boolean
    readonly mustProvideEmail: boolean
  }
  readonly credits: {
    readonly periodStart: string | null
    readonly periodEnd: string | null
    readonly allocated: string
    readonly settled: string
    readonly available: string
  }
}

export interface DeviceSession {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly createdAt: string
  readonly lastUsedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly current: boolean
}

export interface UsageResponse {
  readonly summary: {
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly settledCredits: string
  }
  readonly records: ReadonlyArray<{
    readonly id: string
    readonly turnId: string
    readonly modelId: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalCredits: string
    readonly usageSource: 'upstream' | 'estimated'
    readonly completedAt: string
  }>
}
