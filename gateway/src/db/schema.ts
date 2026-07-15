import type { ColumnType, Generated } from 'kysely'

type Timestamp = ColumnType<string, string, string>
type NullableTimestamp = ColumnType<string | null, string | null | undefined, string | null>
type Version = ColumnType<number, number | undefined, number>

export interface GatewayMetaTable {
  key: string
  value: string
  updated_at: Timestamp
}

export interface AccountTable {
  id: string
  login_name: string | null
  email: string | null
  role: 'level1' | 'level2' | 'user'
  organization_id: string | null
  status: 'active' | 'disabled' | 'expired'
  expires_at: NullableTimestamp
  must_change_password: Generated<number>
  must_provide_email: Generated<number>
  created_at: Timestamp
  updated_at: Timestamp
  disabled_at: NullableTimestamp
  disabled_by: string | null
  version: Version
}

export interface PasswordCredentialTable {
  account_id: string
  password_hash: string
  kind: 'permanent' | 'bootstrap' | 'temporary'
  created_at: Timestamp
  used_at: NullableTimestamp
  expires_at: NullableTimestamp
  password_version: Version
}

export interface OrganizationTable {
  id: string
  name: string
  status: 'active' | 'disabled'
  billing_timezone: string
  audit_retention_days: number
  overdraft_per_turn_override: string | null
  cumulative_risk_override: string | null
  created_at: Timestamp
  updated_at: Timestamp
  version: Version
}

export interface InvitationTable {
  id: string
  organization_id: string
  code_digest: string
  created_by: string
  expires_at: Timestamp
  max_uses: number
  use_count: Generated<number>
  status: 'active' | 'revoked' | 'exhausted' | 'expired'
  created_at: Timestamp
  revoked_at: NullableTimestamp
  revoked_by: string | null
}

export interface DeviceSessionTable {
  id: string
  account_id: string
  device_name: string
  platform: 'windows' | 'macos' | 'other'
  created_at: Timestamp
  last_used_at: Timestamp
  expires_at: Timestamp
  revoked_at: NullableTimestamp
  revoked_by: string | null
  revoke_reason: string | null
  password_version: number
}

export interface RefreshTokenTable {
  id: string
  session_id: string
  family_id: string
  token_digest: string
  parent_token_id: string | null
  issued_at: Timestamp
  expires_at: Timestamp
  consumed_at: NullableTimestamp
  revoked_at: NullableTimestamp
}

export interface AuthorizationCodeTable {
  code_digest: string
  account_id: string
  pkce_challenge: string
  redirect_uri: string
  state_binding: string
  expires_at: Timestamp
  consumed_at: NullableTimestamp
}

export interface WebviewTicketTable {
  ticket_digest: string
  account_id: string
  device_session_id: string
  audience: string
  role_version: number
  expires_at: Timestamp
  consumed_at: NullableTimestamp
}

export interface WebviewSessionTable {
  id: string
  account_id: string
  device_session_id: string
  expires_at: Timestamp
  revoked_at: NullableTimestamp
}

export interface ModelRateTable {
  id: string
  model_id: string
  input_credit_per_token: string
  output_credit_per_token: string
  multiplier: string
  effective_from: Timestamp
  effective_to: NullableTimestamp
  visible_to: string
}

export interface OrganizationCreditPeriodTable {
  id: string
  organization_id: string
  period_start: Timestamp
  period_end: Timestamp
  allocated_credits: string
  settled_credits: string
  created_at: Timestamp
  closed_at: NullableTimestamp
  version: Version
}

export interface UserCreditAllocationTable {
  period_id: string
  account_id: string
  allocated_credits: string
  settled_credits: string
  updated_by: string
  updated_at: Timestamp
  version: Version
}

export interface RiskPolicyTable {
  scope: string
  max_overdraft_per_turn: string
  max_cumulative_risk: string
  updated_by: string
  updated_at: Timestamp
}

export interface TurnRiskTable {
  turn_id: string
  account_id: string
  organization_id: string
  device_session_id: string
  model_id: string
  estimated_input_tokens: number
  max_output_tokens: number
  reserved_risk_credits: string
  status: 'reserved' | 'streaming' | 'settled' | 'failed' | 'abandoned'
  created_at: Timestamp
  started_at: NullableTimestamp
  finished_at: NullableTimestamp
  usage_record_id: string | null
  failure_code: string | null
}

export interface UsageRecordTable {
  id: string
  turn_id: string
  account_id: string
  organization_id: string
  period_id: string
  model_id: string
  provider_id: string
  input_tokens: number
  output_tokens: number
  usage_source: 'upstream' | 'estimated'
  input_credits: string
  output_credits: string
  total_credits: string
  started_at: Timestamp
  completed_at: Timestamp
  route_error_code: string | null
}

export interface ConversationAuditTable {
  id: string
  turn_id: string | null
  account_id: string
  organization_id: string
  model_id: string
  user_text_sanitized: string | null
  assistant_text_sanitized: string | null
  input_tokens: number
  output_tokens: number
  created_at: Timestamp
  body_expires_at: Timestamp
  body_deleted_at: NullableTimestamp
  redaction_version: number
}

export interface AdminAuditEventTable {
  id: string
  actor_account_id: string
  organization_id: string | null
  action: string
  target_type: string
  target_id: string | null
  outcome: 'allowed' | 'denied' | 'failed'
  safe_metadata_json: string
  created_at: Timestamp
}

export interface ProviderTable {
  id: string
  kind: 'chatgpt' | 'openai' | 'deepseek' | 'relay'
  display_name: string
  status: 'active' | 'disabled'
  config_json: string
  created_at: Timestamp
  updated_at: Timestamp
  version: Version
}

export interface ProviderCredentialTable {
  id: string
  provider_id: string
  storage_kind: 'plaintext-v1' | 'envelope-v1'
  secret_payload: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface ModelRouteTable {
  id: string
  public_model_id: string
  provider_id: string
  upstream_model_id: string
  priority: number
  enabled: Generated<number>
  policy_json: string
  created_at: Timestamp
  updated_at: Timestamp
  version: Version
}

export interface MockStateTable {
  id: string
  state: string
  account_display: string | null
  role: string | null
  current_model: string | null
  available_credits: string | null
  updated_at: Timestamp
}

export interface GatewayDatabase {
  gateway_meta: GatewayMetaTable
  accounts: AccountTable
  password_credentials: PasswordCredentialTable
  organizations: OrganizationTable
  invitations: InvitationTable
  device_sessions: DeviceSessionTable
  refresh_tokens: RefreshTokenTable
  authorization_codes: AuthorizationCodeTable
  webview_tickets: WebviewTicketTable
  webview_sessions: WebviewSessionTable
  model_rates: ModelRateTable
  organization_credit_periods: OrganizationCreditPeriodTable
  user_credit_allocations: UserCreditAllocationTable
  risk_policies: RiskPolicyTable
  turn_risks: TurnRiskTable
  usage_records: UsageRecordTable
  conversation_audits: ConversationAuditTable
  admin_audit_events: AdminAuditEventTable
  providers: ProviderTable
  provider_credentials: ProviderCredentialTable
  model_routes: ModelRouteTable
  mock_states: MockStateTable
}
