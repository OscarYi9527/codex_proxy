import type { Kysely, Transaction } from 'kysely'
import type { GatewayDatabase } from '../schema.js'
import type { AccountRole } from '../../auth/types.js'
import { addCredits, formatCredits } from '../../credits/decimal.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>
export type ProviderKind = 'chatgpt' | 'openai' | 'deepseek' | 'relay'

export interface ProviderRecord {
  readonly id: string
  readonly kind: ProviderKind
  readonly displayName: string
  readonly status: 'active' | 'disabled'
  readonly config: Record<string, unknown>
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface ProviderCredentialRecord {
  readonly id: string
  readonly providerId: string
  readonly storageKind: 'plaintext-v1' | 'envelope-v1'
  readonly secretPayload: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ModelRouteRecord {
  readonly id: string
  readonly publicModelId: string
  readonly providerId: string
  readonly upstreamModelId: string
  readonly priority: number
  readonly enabled: boolean
  readonly policy: Record<string, unknown>
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface ProviderUsageSummary {
  readonly providerId: string
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly settledCredits: string
  readonly lastUsedAt: string | null
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export class ProviderRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  async inTransaction<T>(callback: (repository: ProviderRepository) => Promise<T>): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('ProviderRepository transaction boundary is unavailable')
    }
    return this.transactionRunner(transaction =>
      callback(new ProviderRepository(transaction))
    )
  }

  async listProviders(): Promise<ProviderRecord[]> {
    const rows = await this.db
      .selectFrom('providers')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map(row => ({
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      status: row.status,
      config: parseObject(row.config_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version
    }))
  }

  async getProvider(id: string): Promise<ProviderRecord | null> {
    const row = await this.db
      .selectFrom('providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? {
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      status: row.status,
      config: parseObject(row.config_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version
    } : null
  }

  async insertProvider(record: ProviderRecord): Promise<void> {
    await this.db.insertInto('providers').values({
      id: record.id,
      kind: record.kind,
      display_name: record.displayName,
      status: record.status,
      config_json: JSON.stringify(record.config),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      version: record.version
    }).execute()
  }

  async updateProvider(id: string, options: {
    displayName?: string
    status?: 'active' | 'disabled'
    config?: Record<string, unknown>
    updatedAt: string
  }): Promise<boolean> {
    const result = await this.db
      .updateTable('providers')
      .set(expression => ({
        ...(options.displayName === undefined ? {} : { display_name: options.displayName }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.config === undefined ? {} : { config_json: JSON.stringify(options.config) }),
        updated_at: options.updatedAt,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', id)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async deleteProvider(id: string): Promise<boolean> {
    await this.db.deleteFrom('model_routes').where('provider_id', '=', id).execute()
    const result = await this.db.deleteFrom('providers').where('id', '=', id).executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  async listCredentials(providerId?: string): Promise<ProviderCredentialRecord[]> {
    let query = this.db.selectFrom('provider_credentials').selectAll()
    if (providerId) query = query.where('provider_id', '=', providerId)
    const rows = await query.orderBy('updated_at', 'desc').execute()
    return rows.map(row => ({
      id: row.id,
      providerId: row.provider_id,
      storageKind: row.storage_kind,
      secretPayload: row.secret_payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  async insertCredential(record: ProviderCredentialRecord): Promise<void> {
    await this.db.insertInto('provider_credentials').values({
      id: record.id,
      provider_id: record.providerId,
      storage_kind: record.storageKind,
      secret_payload: record.secretPayload,
      created_at: record.createdAt,
      updated_at: record.updatedAt
    }).execute()
  }

  async updateCredential(
    providerId: string,
    credentialId: string,
    options: {
      storageKind: ProviderCredentialRecord['storageKind']
      secretPayload: string
      updatedAt: string
    }
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('provider_credentials')
      .set({
        storage_kind: options.storageKind,
        secret_payload: options.secretPayload,
        updated_at: options.updatedAt
      })
      .where('id', '=', credentialId)
      .where('provider_id', '=', providerId)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async deleteCredential(providerId: string, credentialId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('provider_credentials')
      .where('id', '=', credentialId)
      .where('provider_id', '=', providerId)
      .executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  async listModelRoutes(): Promise<ModelRouteRecord[]> {
    const rows = await this.db
      .selectFrom('model_routes')
      .selectAll()
      .orderBy('priority', 'asc')
      .execute()
    return rows.map(row => ({
      id: row.id,
      publicModelId: row.public_model_id,
      providerId: row.provider_id,
      upstreamModelId: row.upstream_model_id,
      priority: row.priority,
      enabled: row.enabled !== 0,
      policy: parseObject(row.policy_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version
    }))
  }

  async listProviderUsageSummaries(providerId?: string): Promise<ProviderUsageSummary[]> {
    let query = this.db
      .selectFrom('usage_records')
      .select([
        'provider_id',
        'input_tokens',
        'output_tokens',
        'total_credits',
        'completed_at'
      ])
    if (providerId) query = query.where('provider_id', '=', providerId)
    const rows = await query.execute()
    const summaries = new Map<string, {
      requests: number
      inputTokens: number
      outputTokens: number
      settledCredits: bigint
      lastUsedAt: string | null
    }>()
    for (const row of rows) {
      const current = summaries.get(row.provider_id) || {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        settledCredits: 0n,
        lastUsedAt: null
      }
      current.requests += 1
      current.inputTokens += row.input_tokens
      current.outputTokens += row.output_tokens
      current.settledCredits = addCredits(current.settledCredits, row.total_credits)
      if (!current.lastUsedAt || row.completed_at > current.lastUsedAt) {
        current.lastUsedAt = row.completed_at
      }
      summaries.set(row.provider_id, current)
    }
    return [...summaries].map(([id, value]) => ({
      providerId: id,
      requests: value.requests,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      settledCredits: formatCredits(value.settledCredits),
      lastUsedAt: value.lastUsedAt
    }))
  }

  async upsertModelRoute(record: ModelRouteRecord): Promise<void> {
    await this.db
      .insertInto('model_routes')
      .values({
        id: record.id,
        public_model_id: record.publicModelId,
        provider_id: record.providerId,
        upstream_model_id: record.upstreamModelId,
        priority: record.priority,
        enabled: record.enabled ? 1 : 0,
        policy_json: JSON.stringify(record.policy),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        version: record.version
      })
      .onConflict(conflict => conflict.column('id').doUpdateSet(expression => ({
        public_model_id: expression.ref('excluded.public_model_id'),
        provider_id: expression.ref('excluded.provider_id'),
        upstream_model_id: expression.ref('excluded.upstream_model_id'),
        priority: expression.ref('excluded.priority'),
        enabled: expression.ref('excluded.enabled'),
        policy_json: expression.ref('excluded.policy_json'),
        updated_at: expression.ref('excluded.updated_at'),
        version: expression('model_routes.version', '+', 1)
      })))
      .execute()
  }

  async countPlaintextCredentials(): Promise<number> {
    const row = await this.db
      .selectFrom('provider_credentials')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('storage_kind', '=', 'plaintext-v1')
      .executeTakeFirstOrThrow()
    return Number(row.count)
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
      safe_metadata_json: JSON.stringify(options.safeMetadata || {}),
      created_at: options.createdAt
    }).execute()
  }

  async accountRole(accountId: string): Promise<AccountRole | null> {
    const row = await this.db
      .selectFrom('accounts')
      .select('role')
      .where('id', '=', accountId)
      .executeTakeFirst()
    return row?.role || null
  }
}
