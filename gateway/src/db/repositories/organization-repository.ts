import { sql, type Kysely, type Transaction } from 'kysely'
import type { GatewayDatabase } from '../schema.js'
import type { AccountRole } from '../../auth/types.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>

export interface OrganizationSummary {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'disabled'
  readonly updatedAt: string
  readonly version: number
}

export interface OrganizationAccountSummary {
  readonly id: string
  readonly loginName: string | null
  readonly email: string | null
  readonly role: AccountRole
  readonly status: 'active' | 'disabled' | 'expired'
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

export class OrganizationRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      operation: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  inTransaction<T>(operation: (repository: OrganizationRepository) => Promise<T>): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('Organization repository transaction is unavailable')
    }
    return this.transactionRunner(transaction =>
      operation(new OrganizationRepository(transaction))
    )
  }

  async listOrganizations(): Promise<OrganizationSummary[]> {
    const rows = await this.db
      .selectFrom('organizations')
      .select(['id', 'name', 'status', 'updated_at', 'version'])
      .orderBy('name', 'asc')
      .execute()
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      updatedAt: row.updated_at,
      version: row.version
    }))
  }

  async listAccountsForOrganization(organizationId: string): Promise<OrganizationAccountSummary[]> {
    const rows = await this.db
      .selectFrom('accounts')
      .select([
        'id',
        'login_name',
        'email',
        'role',
        'status',
        'organization_id',
        'expires_at',
        'version'
      ])
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map(row => ({
      id: row.id,
      loginName: row.login_name,
      email: row.email,
      role: row.role,
      status: row.status,
      organizationId: row.organization_id,
      expiresAt: row.expires_at,
      version: row.version
    }))
  }

  async listAccounts(): Promise<OrganizationAccountSummary[]> {
    const rows = await this.db
      .selectFrom('accounts')
      .select([
        'id', 'login_name', 'email', 'role', 'status',
        'organization_id', 'expires_at', 'version'
      ])
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map(row => this.toAccount(row))
  }

  async findAccount(accountId: string): Promise<OrganizationAccountSummary | null> {
    const row = await this.db
      .selectFrom('accounts')
      .select([
        'id',
        'login_name',
        'email',
        'role',
        'status',
        'organization_id',
        'expires_at',
        'version'
      ])
      .where('id', '=', accountId)
      .executeTakeFirst()
    return row ? this.toAccount(row) : null
  }

  async countActiveLevel1(): Promise<number> {
    const result = await this.db
      .selectFrom('accounts')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('role', '=', 'level1')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow()
    return Number(result.count)
  }

  async findOrganization(organizationId: string): Promise<OrganizationSummary | null> {
    const row = await this.db.selectFrom('organizations')
      .select(['id', 'name', 'status', 'updated_at', 'version'])
      .where('id', '=', organizationId)
      .executeTakeFirst()
    return row ? {
      id: row.id, name: row.name, status: row.status,
      updatedAt: row.updated_at, version: row.version
    } : null
  }

  async createOrganization(input: {
    id: string
    name: string
    now: string
  }): Promise<OrganizationSummary> {
    await this.db.insertInto('organizations').values({
      id: input.id,
      name: input.name,
      status: 'active',
      billing_timezone: 'Asia/Shanghai',
      audit_retention_days: 30,
      overdraft_per_turn_override: null,
      cumulative_risk_override: null,
      created_at: input.now,
      updated_at: input.now,
      version: 1
    }).execute()
    return (await this.findOrganization(input.id))!
  }

  async updateAccountStatus(accountId: string, status: 'active' | 'disabled', now: string, actorId: string): Promise<boolean> {
    const result = await this.db.updateTable('accounts')
      .set({
        status,
        disabled_at: status === 'disabled' ? now : null,
        disabled_by: status === 'disabled' ? actorId : null,
        updated_at: now,
        version: sql`version + 1`
      })
      .where('id', '=', accountId)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async updateAccountRole(
    accountId: string,
    role: AccountRole,
    organizationId: string | null,
    now: string
  ): Promise<boolean> {
    const result = await this.db.updateTable('accounts')
      .set({
        role,
        organization_id: organizationId,
        updated_at: now,
        version: sql`version + 1`
      })
      .where('id', '=', accountId)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async createInvitation(input: {
    id: string
    organizationId: string
    codeDigest: string
    createdBy: string
    expiresAt: string
    maxUses: number
    now: string
  }): Promise<void> {
    await this.db.insertInto('invitations').values({
      id: input.id, organization_id: input.organizationId,
      code_digest: input.codeDigest, created_by: input.createdBy,
      expires_at: input.expiresAt, max_uses: input.maxUses, use_count: 0,
      status: 'active', created_at: input.now, revoked_at: null, revoked_by: null
    }).execute()
  }

  async listInvitations(organizationId?: string): Promise<InvitationSummary[]> {
    let query = this.db.selectFrom('invitations')
      .select(['id', 'organization_id', 'expires_at', 'max_uses', 'use_count', 'status', 'created_at', 'revoked_at'])
      .orderBy('created_at', 'desc')
    if (organizationId) query = query.where('organization_id', '=', organizationId)
    const rows = await query.execute()
    return rows.map(row => ({
      id: row.id, organizationId: row.organization_id, expiresAt: row.expires_at,
      maxUses: row.max_uses, useCount: row.use_count, status: row.status,
      createdAt: row.created_at, revokedAt: row.revoked_at
    }))
  }

  async revokeInvitation(id: string, now: string, actorId: string): Promise<boolean> {
    const result = await this.db.updateTable('invitations')
      .set({ status: 'revoked', revoked_at: now, revoked_by: actorId })
      .where('id', '=', id).where('status', '=', 'active')
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  private toAccount(row: {
    id: string; login_name: string | null; email: string | null; role: AccountRole
    status: 'active' | 'disabled' | 'expired'; organization_id: string | null
    expires_at: string | null; version: number
  }): OrganizationAccountSummary {
    return {
      id: row.id, loginName: row.login_name, email: row.email, role: row.role,
      status: row.status, organizationId: row.organization_id,
      expiresAt: row.expires_at, version: row.version
    }
  }
}
