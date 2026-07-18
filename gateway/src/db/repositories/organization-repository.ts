import type { Kysely, Transaction } from 'kysely'
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

export class OrganizationRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transaction: <T>(
      operation: (repository: OrganizationRepository) => Promise<T>
    ) => Promise<T>
  ) {}

  inTransaction<T>(operation: (repository: OrganizationRepository) => Promise<T>): Promise<T> {
    return this.transaction(operation)
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
    return row ? {
      id: row.id,
      loginName: row.login_name,
      email: row.email,
      role: row.role,
      status: row.status,
      organizationId: row.organization_id,
      expiresAt: row.expires_at,
      version: row.version
    } : null
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
}
