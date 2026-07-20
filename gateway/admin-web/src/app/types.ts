export type AccountRole = 'level1' | 'level2' | 'user'
export type AccountStatus = 'active' | 'disabled' | 'expired'

export type ManagementRoute =
  | 'account'
  | 'security'
  | 'organization'
  | 'invitations'
  | 'credits'
  | 'usage'
  | 'audit'
  | 'providers'
  | 'diagnostics'

export interface ManagementBootstrapMessage {
  readonly type: 'ai-editor-management-bootstrap'
  readonly version: 1
  readonly route: ManagementRoute
  readonly ticket: string
  readonly expiresIn: number
}

export interface CurrentCodexAuthMessage {
  readonly type: 'ai-editor-current-codex-auth'
  readonly version: 1
  readonly authJson?: string
  readonly errorId?: string
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
    readonly status: AccountStatus
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

export interface OrganizationSummary {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'disabled'
  readonly auditRetentionDays: number
  readonly updatedAt: string
  readonly version: number
}

export interface OrganizationAccountSummary {
  readonly id: string
  readonly loginName: string | null
  readonly email: string | null
  readonly role: AccountRole
  readonly status: AccountStatus
  readonly organizationId: string | null
  readonly expiresAt: string | null
  readonly version: number
}

export interface InvitationSummary {
  readonly id: string
  readonly organizationId: string
  readonly expiresAt: string
  readonly maxUses: number
  readonly useCount: number
  readonly status: 'active' | 'revoked' | 'exhausted' | 'expired'
  readonly createdAt: string
  readonly revokedAt: string | null
}

export interface InvitationCreation {
  readonly code: string
  readonly organizationId: string
  readonly expiresAt: string
  readonly maxUses: number
}

export interface PublicMvpCapacity {
  readonly phase: 'public_mvp'
  readonly hardLimit: number
  readonly admittedAccountCount: number
  readonly remainingAccountCount: number | null
  readonly longTermCoreReady: boolean
  readonly account31Blocked: boolean
  readonly includesAdministrators: true
  readonly updatedAt: string
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

export interface ConversationAuditSummary {
  readonly id: string
  readonly turnId: string | null
  readonly accountId: string
  readonly organizationId: string
  readonly modelId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly createdAt: string
  readonly bodyExpiresAt: string
  readonly bodyDeletedAt: string | null
  readonly redactionVersion: number
}

export interface ConversationAuditDetail extends ConversationAuditSummary {
  readonly userText: string | null
  readonly assistantText: string | null
}

export interface ConversationAuditListResponse {
  readonly conversations: readonly ConversationAuditSummary[]
}

export interface AdminAuditEvent {
  readonly id: string
  readonly actorAccountId: string
  readonly actorRole: AccountRole
  readonly organizationId: string | null
  readonly action: string
  readonly targetType: string
  readonly targetId: string | null
  readonly outcome: 'allowed' | 'denied' | 'failed'
  readonly errorCode: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface AdminAuditEventListResponse {
  readonly events: readonly AdminAuditEvent[]
}

export interface ModelRateSummary {
  readonly modelId: string
  readonly inputCreditPerToken: string
  readonly outputCreditPerToken: string
  readonly multiplier: string
}

export interface OrganizationCreditView {
  readonly organization: { readonly id: string; readonly name: string }
  readonly period: {
    readonly id: string
    readonly periodStart: string
    readonly periodEnd: string
    readonly allocated: string
    readonly settled: string
    readonly available: string
  }
  readonly users: ReadonlyArray<{
    readonly accountId: string
    readonly display: string
    readonly allocated: string
    readonly settled: string
    readonly available: string
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
  }>
  readonly usage: {
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly settledCredits: string
  }
  readonly riskPolicy?: {
    readonly maxOverdraftPerTurn: string
    readonly maxCumulativeRisk: string
    readonly activeRiskCredits: string
  }
  readonly modelRates?: readonly ModelRateSummary[]
}

export interface ProviderCredentialSummary {
  readonly id: string
  readonly maskedPreview: string
  readonly storageFormat: 'plaintext-v1' | 'envelope-v1'
  readonly updatedAt: string
  readonly lastUsedAt: string | null
  readonly label: string | null
  readonly accountIdPreview: string | null
  readonly planType: string | null
  readonly status: string
  readonly routing: {
    readonly enabled: boolean
    readonly weight: number
    readonly lowQuotaThreshold: number
    readonly dailyRequestLimit: number
    readonly dailyTokenLimit: number
    readonly reservedModels: readonly string[]
  } | null
  readonly quota: {
    readonly source: 'provider' | 'unavailable'
    readonly primary: ProviderQuotaWindow | null
    readonly secondary: ProviderQuotaWindow | null
    readonly updatedAt: string | null
    readonly syncStatus: string
    readonly syncError: string | null
  }
  readonly runtime: {
    readonly activeRequests: number
    readonly concurrencyLimit: number
    readonly cooldownUntil: number | null
    readonly modelCooldowns: number
  }
  readonly health: {
    readonly requests: number
    readonly successRate: number | null
    readonly p95LatencyMs: number
    readonly rateLimited: number
    readonly lastRequestAt: string | null
    readonly lastErrorType: string | null
    readonly lastErrorMessage: string | null
  }
}

export interface ProviderQuotaWindow {
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly resetsAt: number | null
  readonly windowMinutes: number | null
}

export type AccountRoutingStrategy =
  | 'priority'
  | 'round-robin'
  | 'headroom'
  | 'least-used'
  | 'latency'
  | 'reliable'
  | 'weighted'
  | 'random'
  | 'lkgp'

export interface ProviderSummary {
  readonly id: string
  readonly kind: 'chatgpt' | 'openai' | 'deepseek' | 'relay'
  readonly displayName: string
  readonly status: 'active' | 'disabled'
  readonly config: {
    readonly baseUrl?: string
    readonly models?: readonly string[]
    readonly internalBudgetCredits?: string
  }
  readonly version: number
  readonly updatedAt: string
  readonly credentials: readonly ProviderCredentialSummary[]
  readonly runtimeHealth?: {
    readonly state: string
    readonly circuitState: string
    readonly lastCheckedAt: string | null
    readonly lastStatus: number | null
    readonly lastLatencyMs: number | null
    readonly lastError: string | null
    readonly requests: number
    readonly successRate: number | null
    readonly p95LatencyMs: number
  }
  readonly usage?: {
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly settledCredits: string
    readonly internalBudgetCredits: string | null
    readonly remainingCredits: string | null
    readonly usedPercent: string | null
    readonly lastUsedAt: string | null
  }
  readonly plaintextWarning: string | null
}

export interface ProviderListResponse {
  readonly warning: string | null
  readonly accountPool: {
    readonly strategy: AccountRoutingStrategy
    readonly accounts: readonly unknown[]
    readonly queueDepth: number
    readonly recentRouteDecisions: ReadonlyArray<{
      readonly at: string
      readonly model: string
      readonly selectedAccountId: string | null
      readonly selectedAccountLabel: string | null
      readonly outcome: string
      readonly queueWaitMs: number
      readonly accounts: ReadonlyArray<{
        readonly id: string
        readonly label: string
        readonly result: string
        readonly reason: string
        readonly remainingPercent: number | null
      }>
    }>
  }
  readonly providers: readonly ProviderSummary[]
}

export interface ModelRouteSummary {
  readonly id: string
  readonly publicModelId: string
  readonly providerId: string
  readonly upstreamModelId: string
  readonly priority: number
  readonly enabled: boolean
}

export interface ModelRouteResponse {
  readonly models: readonly ModelRouteSummary[]
  readonly rates?: readonly ModelRateSummary[]
}

export interface ChatgptLoginStatus {
  readonly id?: string
  readonly status: 'idle' | 'waiting' | 'success' | 'error' | 'cancelled'
  readonly message?: string
  readonly startedAt?: string
  readonly verificationUrl?: string | null
  readonly codexSource?: string | null
  readonly codexVersion?: string | null
}

export interface ChatgptAccountLoginStatus extends ChatgptLoginStatus {
  readonly providerId?: string
}

export interface ChatgptAccountImportResult {
  readonly providerId: string
  readonly credentialId: string
  readonly accountIdPreview: string
  readonly created: boolean
  readonly routingEnabled: boolean
  readonly warning: string
}

export type ProviderDiagnostics = Readonly<Record<string, unknown>>
