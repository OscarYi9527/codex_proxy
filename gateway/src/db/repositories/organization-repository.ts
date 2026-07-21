import type { Kysely, Transaction } from 'kysely'
import { redactValue } from '../../common/redaction.js'
import type { AccountRole, AccountStatus } from '../../auth/types.js'
import type { GatewayDatabase } from '../schema.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>

export type OrganizationScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'organization'; readonly organizationId: string }

export interface OrganizationRecord {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'disabled'
  readonly billingTimezone: string
  readonly auditRetentionDays: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface ManagedAccountRecord {
  readonly id: string
  readonly loginName: string | null
  readonly email: string | null
  readonly role: AccountRole
  readonly organizationId: string | null
  readonly status: AccountStatus
  readonly expiresAt: string | null
  readonly mustChangePassword: boolean
  readonly mustProvideEmail: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly disabledAt: string | null
  readonly disabledBy: string | null
  readonly version: number
}

export interface InvitationRecord {
  readonly id: string
  readonly organizationId: string
  readonly createdBy: string
  readonly expiresAt: string
  readonly maxUses: number
  readonly useCount: number
  readonly status: 'active' | 'revoked' | 'exhausted' | 'expired'
  readonly createdAt: string
  readonly revokedAt: string | null
  readonly revokedBy: string | null
}

function organizationRecord(row: {
  id: string
  name: string
  status: 'active' | 'disabled'
  billing_timezone: string
  audit_retention_days: number
  created_at: string
  updated_at: string
  version: number
}): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    billingTimezone: row.billing_timezone,
    auditRetentionDays: row.audit_retention_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version
  }
}

function accountRecord(row: {
  id: string
  login_name: string | null
  email: string | null
  role: AccountRole
  organization_id: string | null
  status: AccountStatus
  expires_at: string | null
  must_change_password: number
  must_provide_email: number
  created_at: string
  updated_at: string
  disabled_at: string | null
  disabled_by: string | null
  version: number
}): ManagedAccountRecord {
  return {
    id: row.id,
    loginName: row.login_name,
    email: row.email,
    role: row.role,
    organizationId: row.organization_id,
    status: row.status,
    expiresAt: row.expires_at,
    mustChangePassword: row.must_change_password !== 0,
    mustProvideEmail: row.must_provide_email !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
    disabledBy: row.disabled_by,
    version: row.version
  }
}

function invitationRecord(row: {
  id: string
  organization_id: string
  created_by: string
  expires_at: string
  max_uses: number
  use_count: number
  status: 'active' | 'revoked' | 'exhausted' | 'expired'
  created_at: string
  revoked_at: string | null
  revoked_by: string | null
}, now: string): InvitationRecord {
  const status = row.status === 'active' && row.expires_at <= now
    ? 'expired'
    : row.status
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by
  }
}

const accountColumns = [
  'id',
  'login_name',
  'email',
  'role',
  'organization_id',
  'status',
  'expires_at',
  'must_change_password',
  'must_provide_email',
  'created_at',
  'updated_at',
  'disabled_at',
  'disabled_by',
  'version'
] as const

const invitationColumns = [
  'id',
  'organization_id',
  'created_by',
  'expires_at',
  'max_uses',
  'use_count',
  'status',
  'created_at',
  'revoked_at',
  'revoked_by'
] as const

export class OrganizationRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  async inTransaction<T>(
    callback: (repository: OrganizationRepository) => Promise<T>
  ): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('OrganizationRepository transaction boundary is unavailable')
    }
    return this.transactionRunner(transaction =>
      callback(new OrganizationRepository(transaction))
    )
  }

  async listOrganizations(scope: OrganizationScope): Promise<OrganizationRecord[]> {
    let query = this.db
      .selectFrom('organizations')
      .select([
        'id',
        'name',
        'status',
        'billing_timezone',
        'audit_retention_days',
        'created_at',
        'updated_at',
        'version'
      ])
    if (scope.kind === 'organization') {
      query = query.where('id', '=', scope.organizationId)
    }
    const rows = await query.orderBy('name', 'asc').execute()
    return rows.map(organizationRecord)
  }

  async getOrganization(
    scope: OrganizationScope,
    organizationId: string
  ): Promise<OrganizationRecord | null> {
    let query = this.db
      .selectFrom('organizations')
      .select([
        'id',
        'name',
        'status',
        'billing_timezone',
        'audit_retention_days',
        'created_at',
        'updated_at',
        'version'
      ])
      .where('id', '=', organizationId)
    if (scope.kind === 'organization') {
      query = query.where('id', '=', scope.organizationId)
    }
    const row = await query.executeTakeFirst()
    return row ? organizationRecord(row) : null
  }

  async organizationNameExists(name: string, exceptId?: string): Promise<boolean> {
    let query = this.db
      .selectFrom('organizations')
      .select('id')
      .where('name', '=', name)
    if (exceptId) query = query.where('id', '!=', exceptId)
    return Boolean(await query.executeTakeFirst())
  }

  async insertOrganization(record: OrganizationRecord): Promise<void> {
    await this.db.insertInto('organizations').values({
      id: record.id,
      name: record.name,
      status: record.status,
      billing_timezone: record.billingTimezone,
      audit_retention_days: record.auditRetentionDays,
      overdraft_per_turn_override: null,
      cumulative_risk_override: null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      version: record.version
    }).execute()
  }

  async updateOrganization(
    scope: OrganizationScope,
    organizationId: string,
    patch: {
      name?: string
      status?: 'active' | 'disabled'
      billingTimezone?: string
      auditRetentionDays?: number
      updatedAt: string
    }
  ): Promise<boolean> {
    let query = this.db
      .updateTable('organizations')
      .set(expression => ({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.billingTimezone === undefined
          ? {}
          : { billing_timezone: patch.billingTimezone }),
        ...(patch.auditRetentionDays === undefined
          ? {}
          : { audit_retention_days: patch.auditRetentionDays }),
        updated_at: patch.updatedAt,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', organizationId)
    if (scope.kind === 'organization') {
      query = query.where('id', '=', scope.organizationId)
    }
    const result = await query.executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async listAccounts(
    scope: OrganizationScope,
    options: { readonly ordinaryUsersOnly?: boolean } = {}
  ): Promise<ManagedAccountRecord[]> {
    let query = this.db.selectFrom('accounts').select(accountColumns)
    if (scope.kind === 'organization') {
      query = query.where('organization_id', '=', scope.organizationId)
    }
    if (options.ordinaryUsersOnly) {
      query = query.where('role', '=', 'user')
    }
    const rows = await query.orderBy('created_at', 'asc').execute()
    return rows.map(accountRecord)
  }

  async getAccount(
    scope: OrganizationScope,
    accountId: string
  ): Promise<ManagedAccountRecord | null> {
    let query = this.db
      .selectFrom('accounts')
      .select(accountColumns)
      .where('id', '=', accountId)
    if (scope.kind === 'organization') {
      query = query.where('organization_id', '=', scope.organizationId)
    }
    const row = await query.executeTakeFirst()
    return row ? accountRecord(row) : null
  }

  async emailExists(email: string, exceptAccountId: string): Promise<boolean> {
    return Boolean(await this.db
      .selectFrom('accounts')
      .select('id')
      .where('email', '=', email)
      .where('id', '!=', exceptAccountId)
      .executeTakeFirst())
  }

  async updateAccount(
    scope: OrganizationScope,
    accountId: string,
    patch: {
      email?: string | null
      role?: AccountRole
      organizationId?: string | null
      status?: AccountStatus
      expiresAt?: string | null
      mustChangePassword?: boolean
      updatedAt: string
      disabledAt?: string | null
      disabledBy?: string | null
    },
    options: { readonly ordinaryUsersOnly?: boolean } = {}
  ): Promise<boolean> {
    let query = this.db
      .updateTable('accounts')
      .set(expression => ({
        ...(patch.email === undefined ? {} : { email: patch.email }),
        ...(patch.role === undefined ? {} : { role: patch.role }),
        ...(patch.organizationId === undefined
          ? {}
          : { organization_id: patch.organizationId }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.expiresAt === undefined ? {} : { expires_at: patch.expiresAt }),
        ...(patch.mustChangePassword === undefined
          ? {}
          : { must_change_password: patch.mustChangePassword ? 1 : 0 }),
        ...(patch.disabledAt === undefined ? {} : { disabled_at: patch.disabledAt }),
        ...(patch.disabledBy === undefined ? {} : { disabled_by: patch.disabledBy }),
        updated_at: patch.updatedAt,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', accountId)
    if (scope.kind === 'organization') {
      query = query.where('organization_id', '=', scope.organizationId)
    }
    if (options.ordinaryUsersOnly) {
      query = query.where('role', '=', 'user')
    }
    const result = await query.executeTakeFirst()
    const updated = Number(result.numUpdatedRows) === 1
    if (updated) {
      await this.db
        .updateTable('webview_sessions')
        .set({ revoked_at: patch.updatedAt })
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .execute()
    }
    return updated
  }

  async serializeLevel1Invariant(now: string): Promise<void> {
    await this.db
      .insertInto('gateway_meta')
      .values({
        key: 'lock:effective-level1',
        value: '1',
        updated_at: now
      })
      .onConflict(conflict => conflict
        .column('key')
        .doUpdateSet({ updated_at: now }))
      .execute()
  }

  async serializeOrganization(
    organizationId: string,
    now: string
  ): Promise<void> {
    await this.db
      .insertInto('gateway_meta')
      .values({
        key: `lock:organization:${organizationId}`,
        value: '1',
        updated_at: now
      })
      .onConflict(conflict => conflict
        .column('key')
        .doUpdateSet({ updated_at: now }))
      .execute()
  }

  async countEffectiveLevel1(now: string): Promise<number> {
    const row = await this.db
      .selectFrom('accounts as account')
      .leftJoin(
        'organizations as organization',
        'organization.id',
        'account.organization_id'
      )
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('account.role', '=', 'level1')
      .where('account.status', '=', 'active')
      .where(expression => expression.or([
        expression('account.expires_at', 'is', null),
        expression('account.expires_at', '>', now)
      ]))
      .where(expression => expression.or([
        expression('account.organization_id', 'is', null),
        expression('organization.status', '=', 'active')
      ]))
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async setTemporaryPassword(options: {
    scope: OrganizationScope
    accountId: string
    passwordHash: string
    now: string
    expiresAt: string
  }): Promise<boolean> {
    let credentialQuery = this.db
      .selectFrom('password_credentials')
      .innerJoin('accounts', 'accounts.id', 'password_credentials.account_id')
      .select('password_version')
      .where('password_credentials.account_id', '=', options.accountId)
    if (options.scope.kind === 'organization') {
      credentialQuery = credentialQuery.where(
        'accounts.organization_id',
        '=',
        options.scope.organizationId
      )
    }
    const credential = await credentialQuery.executeTakeFirst()
    if (!credential) return false
    const passwordVersion = credential.password_version + 1
    await this.db
      .updateTable('password_credentials')
      .set({
        password_hash: options.passwordHash,
        kind: 'temporary',
        created_at: options.now,
        used_at: null,
        expires_at: options.expiresAt,
        password_version: passwordVersion
      })
      .where('account_id', '=', options.accountId)
      .execute()
    await this.db
      .updateTable('accounts')
      .set(expression => ({
        must_change_password: 1,
        updated_at: options.now,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', options.accountId)
      .execute()
    const sessions = await this.db
      .selectFrom('device_sessions')
      .select('id')
      .where('account_id', '=', options.accountId)
      .where('revoked_at', 'is', null)
      .execute()
    for (const session of sessions) {
      await this.db
        .updateTable('device_sessions')
        .set({
          revoked_at: options.now,
          revoke_reason: 'temporary_password_issued'
        })
        .where('id', '=', session.id)
        .execute()
      await this.db
        .updateTable('refresh_tokens')
        .set({ revoked_at: options.now })
        .where('session_id', '=', session.id)
        .where('revoked_at', 'is', null)
        .execute()
    }
    return true
  }

  async listInvitations(
    scope: OrganizationScope,
    now: string
  ): Promise<InvitationRecord[]> {
    let query = this.db.selectFrom('invitations').select(invitationColumns)
    if (scope.kind === 'organization') {
      query = query.where('organization_id', '=', scope.organizationId)
    }
    const rows = await query.orderBy('created_at', 'desc').execute()
    return rows.map(row => invitationRecord(row, now))
  }

  async getInvitation(
    scope: OrganizationScope,
    invitationId: string,
    now: string
  ): Promise<InvitationRecord | null> {
    let query = this.db
      .selectFrom('invitations')
      .select(invitationColumns)
      .where('id', '=', invitationId)
    if (scope.kind === 'organization') {
      query = query.where('organization_id', '=', scope.organizationId)
    }
    const row = await query.executeTakeFirst()
    return row ? invitationRecord(row, now) : null
  }

  async insertInvitation(options: {
    id: string
    organizationId: string
    codeDigest: string
    createdBy: string
    expiresAt: string
    maxUses: number
    createdAt: string
  }): Promise<void> {
    await this.db.insertInto('invitations').values({
      id: options.id,
      organization_id: options.organizationId,
      code_digest: options.codeDigest,
      created_by: options.createdBy,
      expires_at: options.expiresAt,
      max_uses: options.maxUses,
      use_count: 0,
      status: 'active',
      created_at: options.createdAt,
      revoked_at: null,
      revoked_by: null
    }).execute()
  }

  async revokeInvitation(options: {
    scope: OrganizationScope
    invitationId: string
    revokedAt: string
    revokedBy: string
  }): Promise<boolean> {
    let query = this.db
      .updateTable('invitations')
      .set({
        status: 'revoked',
        revoked_at: options.revokedAt,
        revoked_by: options.revokedBy
      })
      .where('id', '=', options.invitationId)
      .where('status', '=', 'active')
    if (options.scope.kind === 'organization') {
      query = query.where('organization_id', '=', options.scope.organizationId)
    }
    const result = await query.executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async insertAuditEvent(options: {
    id: string
    actorAccountId: string
    organizationId: string | null
    action: string
    targetType: string
    targetId: string | null
    outcome: 'allowed' | 'denied' | 'failed'
    safeMetadata?: Record<string, unknown>
    createdAt: string
  }): Promise<void> {
    await this.db.insertInto('admin_audit_events').values({
      id: options.id,
      actor_account_id: options.actorAccountId,
      organization_id: options.organizationId,
      action: options.action,
      target_type: options.targetType,
      target_id: options.targetId,
      outcome: options.outcome,
      safe_metadata_json: JSON.stringify(redactValue(options.safeMetadata || {})),
      created_at: options.createdAt
    }).execute()
  }
}
