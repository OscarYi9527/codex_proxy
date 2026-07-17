import type { Kysely, Transaction } from 'kysely'
import type { GatewayDatabase } from '../schema.js'
import type { AccountRole } from '../../auth/types.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>

export interface WebviewTicketRecord {
  readonly ticketDigest: string
  readonly accountId: string
  readonly deviceSessionId: string
  readonly audience: string
  readonly roleVersion: number
  readonly expiresAt: string
  readonly consumedAt: string | null
}

export interface AccountDeviceContext {
  readonly deviceSessionId: string
  readonly deviceExpiresAt: string
  readonly deviceRevokedAt: string | null
  readonly sessionPasswordVersion: number
  readonly credentialPasswordVersion: number
  readonly accountId: string
  readonly role: AccountRole
  readonly organizationId: string | null
  readonly accountStatus: 'active' | 'disabled' | 'expired'
  readonly accountExpiresAt: string | null
  readonly organizationStatus: 'active' | 'disabled' | null
  readonly accountVersion: number
}

export interface WebviewSessionContext extends AccountDeviceContext {
  readonly sessionDigest: string
  readonly webviewExpiresAt: string
  readonly webviewRevokedAt: string | null
}

export class WebviewSessionRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  async inTransaction<T>(
    callback: (repository: WebviewSessionRepository) => Promise<T>
  ): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('WebviewSessionRepository transaction boundary is unavailable')
    }
    return this.transactionRunner(transaction =>
      callback(new WebviewSessionRepository(transaction))
    )
  }

  async insertTicket(record: WebviewTicketRecord): Promise<void> {
    await this.db.insertInto('webview_tickets').values({
      ticket_digest: record.ticketDigest,
      account_id: record.accountId,
      device_session_id: record.deviceSessionId,
      audience: record.audience,
      role_version: record.roleVersion,
      expires_at: record.expiresAt,
      consumed_at: record.consumedAt
    }).execute()
  }

  async getTicket(ticketDigest: string): Promise<WebviewTicketRecord | null> {
    const row = await this.db
      .selectFrom('webview_tickets')
      .selectAll()
      .where('ticket_digest', '=', ticketDigest)
      .executeTakeFirst()
    return row ? {
      ticketDigest: row.ticket_digest,
      accountId: row.account_id,
      deviceSessionId: row.device_session_id,
      audience: row.audience,
      roleVersion: row.role_version,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at
    } : null
  }

  async consumeTicket(ticketDigest: string, now: string): Promise<boolean> {
    const result = await this.db
      .updateTable('webview_tickets')
      .set({ consumed_at: now })
      .where('ticket_digest', '=', ticketDigest)
      .where('consumed_at', 'is', null)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async insertSession(options: {
    sessionDigest: string
    accountId: string
    deviceSessionId: string
    expiresAt: string
  }): Promise<void> {
    await this.db.insertInto('webview_sessions').values({
      id: options.sessionDigest,
      account_id: options.accountId,
      device_session_id: options.deviceSessionId,
      expires_at: options.expiresAt,
      revoked_at: null
    }).execute()
  }

  async getSessionContext(sessionDigest: string): Promise<WebviewSessionContext | null> {
    const row = await this.db
      .selectFrom('webview_sessions as webview')
      .innerJoin('device_sessions as device', 'device.id', 'webview.device_session_id')
      .innerJoin('accounts as account', 'account.id', 'webview.account_id')
      .innerJoin('password_credentials as credential', 'credential.account_id', 'account.id')
      .leftJoin('organizations as organization', 'organization.id', 'account.organization_id')
      .select([
        'webview.id as session_digest',
        'webview.expires_at as webview_expires_at',
        'webview.revoked_at as webview_revoked_at',
        'device.id as device_session_id',
        'device.expires_at as device_expires_at',
        'device.revoked_at as device_revoked_at',
        'device.password_version as session_password_version',
        'credential.password_version as credential_password_version',
        'account.id as account_id',
        'account.role',
        'account.organization_id',
        'account.status as account_status',
        'account.expires_at as account_expires_at',
        'account.version as account_version',
        'organization.status as organization_status'
      ])
      .where('webview.id', '=', sessionDigest)
      .whereRef('device.account_id', '=', 'webview.account_id')
      .executeTakeFirst()
    return row ? {
      sessionDigest: row.session_digest,
      webviewExpiresAt: row.webview_expires_at,
      webviewRevokedAt: row.webview_revoked_at,
      deviceSessionId: row.device_session_id,
      deviceExpiresAt: row.device_expires_at,
      deviceRevokedAt: row.device_revoked_at,
      sessionPasswordVersion: row.session_password_version,
      credentialPasswordVersion: row.credential_password_version,
      accountId: row.account_id,
      role: row.role,
      organizationId: row.organization_id,
      accountStatus: row.account_status,
      accountExpiresAt: row.account_expires_at,
      organizationStatus: row.organization_status,
      accountVersion: row.account_version
    } : null
  }

  async getSessionContextForDevice(
    deviceSessionId: string,
    accountId: string
  ): Promise<AccountDeviceContext | null> {
    const row = await this.db
      .selectFrom('device_sessions as device')
      .innerJoin('accounts as account', 'account.id', 'device.account_id')
      .innerJoin('password_credentials as credential', 'credential.account_id', 'account.id')
      .leftJoin('organizations as organization', 'organization.id', 'account.organization_id')
      .select([
        'device.id as device_session_id',
        'device.expires_at as device_expires_at',
        'device.revoked_at as device_revoked_at',
        'device.password_version as session_password_version',
        'credential.password_version as credential_password_version',
        'account.id as account_id',
        'account.role',
        'account.organization_id',
        'account.status as account_status',
        'account.expires_at as account_expires_at',
        'account.version as account_version',
        'organization.status as organization_status'
      ])
      .where('device.id', '=', deviceSessionId)
      .where('device.account_id', '=', accountId)
      .executeTakeFirst()
    return row ? {
      deviceSessionId: row.device_session_id,
      deviceExpiresAt: row.device_expires_at,
      deviceRevokedAt: row.device_revoked_at,
      sessionPasswordVersion: row.session_password_version,
      credentialPasswordVersion: row.credential_password_version,
      accountId: row.account_id,
      role: row.role,
      organizationId: row.organization_id,
      accountStatus: row.account_status,
      accountExpiresAt: row.account_expires_at,
      organizationStatus: row.organization_status,
      accountVersion: row.account_version
    } : null
  }

  async revokeSession(sessionDigest: string, now: string): Promise<void> {
    await this.db
      .updateTable('webview_sessions')
      .set({ revoked_at: now })
      .where('id', '=', sessionDigest)
      .where('revoked_at', 'is', null)
      .execute()
  }

  async listAccountUsage(accountId: string): Promise<Array<{
    id: string
    turnId: string
    modelId: string
    inputTokens: number
    outputTokens: number
    totalCredits: string
    usageSource: 'upstream' | 'estimated'
    completedAt: string
  }>> {
    const rows = await this.db
      .selectFrom('usage_records')
      .select([
        'id',
        'turn_id',
        'model_id',
        'input_tokens',
        'output_tokens',
        'total_credits',
        'usage_source',
        'completed_at'
      ])
      .where('account_id', '=', accountId)
      .orderBy('completed_at', 'desc')
      .limit(100)
      .execute()
    return rows.map(row => ({
      id: row.id,
      turnId: row.turn_id,
      modelId: row.model_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalCredits: row.total_credits,
      usageSource: row.usage_source,
      completedAt: row.completed_at
    }))
  }
}
