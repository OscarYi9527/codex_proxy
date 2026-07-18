import { sql, type Kysely, type Transaction } from 'kysely'
import type { AccountRole } from '../../auth/types.js'
import type { GatewayDatabase } from '../schema.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>

export interface ConversationAuditRecord {
  readonly id: string
  readonly turnId: string | null
  readonly accountId: string
  readonly organizationId: string
  readonly modelId: string
  readonly userText: string | null
  readonly assistantText: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly createdAt: string
  readonly bodyExpiresAt: string
  readonly bodyDeletedAt: string | null
  readonly redactionVersion: number
}

export interface ConversationAuditSummary extends Omit<
  ConversationAuditRecord,
  'userText' | 'assistantText'
> {}

export interface AdminAuditEventRecord {
  readonly id: string
  readonly actorAccountId: string
  readonly actorRole: AccountRole
  readonly organizationId: string | null
  readonly action: string
  readonly targetType: string
  readonly targetId: string | null
  readonly outcome: 'allowed' | 'denied' | 'failed'
  readonly errorCode: string | null
  readonly metadata: Record<string, unknown>
  readonly createdAt: string
}

function conversation(row: {
  id: string
  turn_id: string | null
  account_id: string
  organization_id: string
  model_id: string
  user_text_sanitized: string | null
  assistant_text_sanitized: string | null
  input_tokens: number
  output_tokens: number
  created_at: string
  body_expires_at: string
  body_deleted_at: string | null
  redaction_version: number
}): ConversationAuditRecord {
  return {
    id: row.id,
    turnId: row.turn_id,
    accountId: row.account_id,
    organizationId: row.organization_id,
    modelId: row.model_id,
    userText: row.user_text_sanitized,
    assistantText: row.assistant_text_sanitized,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
    bodyExpiresAt: row.body_expires_at,
    bodyDeletedAt: row.body_deleted_at,
    redactionVersion: row.redaction_version
  }
}

function safeMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export class AuditRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      operation: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  inTransaction<T>(operation: (repository: AuditRepository) => Promise<T>): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('Audit repository transaction is unavailable')
    }
    return this.transactionRunner(transaction => operation(new AuditRepository(transaction)))
  }

  async organizationRetentionDays(organizationId: string): Promise<number | null> {
    const row = await this.db.selectFrom('organizations')
      .select('audit_retention_days')
      .where('id', '=', organizationId)
      .executeTakeFirst()
    return row?.audit_retention_days ?? null
  }

  async setOrganizationRetentionDays(
    organizationId: string,
    days: number,
    now: string
  ): Promise<boolean> {
    const result = await this.db.updateTable('organizations')
      .set({
        audit_retention_days: days,
        updated_at: now,
        version: sql`version + 1`
      })
      .where('id', '=', organizationId)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async insertConversation(record: ConversationAuditRecord): Promise<void> {
    const values = {
      id: record.id,
      turn_id: record.turnId,
      account_id: record.accountId,
      organization_id: record.organizationId,
      model_id: record.modelId,
      user_text_sanitized: record.userText,
      assistant_text_sanitized: record.assistantText,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      created_at: record.createdAt,
      body_expires_at: record.bodyExpiresAt,
      body_deleted_at: record.bodyDeletedAt,
      redaction_version: record.redactionVersion
    }
    let query = this.db.insertInto('conversation_audits').values(values)
    if (record.turnId) {
      query = query.onConflict(conflict => conflict.column('turn_id').doUpdateSet({
        model_id: record.modelId,
        user_text_sanitized: record.userText,
        assistant_text_sanitized: record.assistantText,
        input_tokens: record.inputTokens,
        output_tokens: record.outputTokens,
        body_expires_at: record.bodyExpiresAt,
        body_deleted_at: record.bodyDeletedAt,
        redaction_version: record.redactionVersion
      }))
    }
    await query.execute()
  }

  async listConversations(options: {
    organizationId?: string
    accountId?: string
    limit?: number
  } = {}): Promise<ConversationAuditSummary[]> {
    let query = this.db.selectFrom('conversation_audits')
      .select([
        'id',
        'turn_id',
        'account_id',
        'organization_id',
        'model_id',
        'input_tokens',
        'output_tokens',
        'created_at',
        'body_expires_at',
        'body_deleted_at',
        'redaction_version'
      ])
    if (options.organizationId) {
      query = query.where('organization_id', '=', options.organizationId)
    }
    if (options.accountId) query = query.where('account_id', '=', options.accountId)
    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(Math.max(1, Math.min(200, options.limit || 100)))
      .execute()
    return rows.map(row => ({
      id: row.id,
      turnId: row.turn_id,
      accountId: row.account_id,
      organizationId: row.organization_id,
      modelId: row.model_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      createdAt: row.created_at,
      bodyExpiresAt: row.body_expires_at,
      bodyDeletedAt: row.body_deleted_at,
      redactionVersion: row.redaction_version
    }))
  }

  async findConversation(id: string): Promise<ConversationAuditRecord | null> {
    const row = await this.db.selectFrom('conversation_audits')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? conversation(row) : null
  }

  async listRetainedBodies(organizationId: string): Promise<Array<{
    id: string
    createdAt: string
  }>> {
    const rows = await this.db.selectFrom('conversation_audits')
      .select(['id', 'created_at'])
      .where('organization_id', '=', organizationId)
      .where('body_deleted_at', 'is', null)
      .execute()
    return rows.map(row => ({ id: row.id, createdAt: row.created_at }))
  }

  async setBodyExpiry(id: string, expiresAt: string): Promise<void> {
    await this.db.updateTable('conversation_audits')
      .set({ body_expires_at: expiresAt })
      .where('id', '=', id)
      .where('body_deleted_at', 'is', null)
      .execute()
  }

  async deleteExpiredBodies(now: string): Promise<number> {
    const result = await this.db.updateTable('conversation_audits')
      .set({
        user_text_sanitized: null,
        assistant_text_sanitized: null,
        body_deleted_at: now
      })
      .where('body_deleted_at', 'is', null)
      .where('body_expires_at', '<=', now)
      .executeTakeFirst()
    return Number(result.numUpdatedRows)
  }

  async insertAdminEvent(record: AdminAuditEventRecord): Promise<void> {
    await this.db.insertInto('admin_audit_events').values({
      id: record.id,
      actor_account_id: record.actorAccountId,
      actor_role: record.actorRole,
      organization_id: record.organizationId,
      action: record.action,
      target_type: record.targetType,
      target_id: record.targetId,
      outcome: record.outcome,
      error_code: record.errorCode,
      safe_metadata_json: JSON.stringify(record.metadata),
      created_at: record.createdAt
    }).execute()
  }

  async listAdminEvents(options: {
    organizationId?: string
    limit?: number
  } = {}): Promise<AdminAuditEventRecord[]> {
    let query = this.db.selectFrom('admin_audit_events').selectAll()
    if (options.organizationId) {
      query = query.where('organization_id', '=', options.organizationId)
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(Math.max(1, Math.min(200, options.limit || 100)))
      .execute()
    return rows.map(row => ({
      id: row.id,
      actorAccountId: row.actor_account_id,
      actorRole: row.actor_role,
      organizationId: row.organization_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      outcome: row.outcome,
      errorCode: row.error_code,
      metadata: safeMetadata(row.safe_metadata_json),
      createdAt: row.created_at
    }))
  }
}
