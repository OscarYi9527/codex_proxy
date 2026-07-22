import type { Kysely, Transaction } from 'kysely'
import type { GatewayDatabase } from '../schema.js'
import type { AccountRole } from '../../auth/types.js'
import { addCredits, formatCredits } from '../../credits/decimal.js'
import type {
  CredentialProtector,
  StoredCredentialSecret
} from '../../security/envelope-credential-protector.js'

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
  readonly keyVersion: string | null
  readonly credentialVersion: number
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

export interface ProviderModelUsageSummary {
  readonly providerId: string
  readonly modelId: string
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface ProviderConsoleUsageRecord {
  readonly providerId: string
  readonly accountId: string
  readonly modelId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly completedAt: string
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
    ) => Promise<T>,
    private readonly credentialProtector?: CredentialProtector
  ) {}

  async inTransaction<T>(callback: (repository: ProviderRepository) => Promise<T>): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('ProviderRepository transaction boundary is unavailable')
    }
    return this.transactionRunner(transaction =>
      callback(new ProviderRepository(
        transaction,
        undefined,
        this.credentialProtector
      ))
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
    const records = await this.listStoredCredentials(providerId)
    return Promise.all(records.map(async record => {
      if (record.storageKind === 'plaintext-v1') return record
      if (!this.credentialProtector) {
        throw new Error(
          'Encrypted Provider credentials are present but no credential key provider is available'
        )
      }
      return {
        ...record,
        secretPayload: await this.credentialProtector.reveal({
          id: record.id,
          providerId: record.providerId,
          credentialVersion: record.credentialVersion
        }, {
          storageKind: 'envelope-v1',
          keyVersion: record.keyVersion,
          secretPayload: record.secretPayload
        })
      }
    }))
  }

  async listStoredCredentials(providerId?: string): Promise<ProviderCredentialRecord[]> {
    let query = this.db.selectFrom('provider_credentials').selectAll()
    if (providerId) query = query.where('provider_id', '=', providerId)
    const rows = await query.orderBy('updated_at', 'desc').execute()
    return rows.map(row => ({
      id: row.id,
      providerId: row.provider_id,
      storageKind: row.storage_kind,
      secretPayload: row.secret_payload,
      keyVersion: row.key_version,
      credentialVersion: row.credential_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  async insertCredential(record: ProviderCredentialRecord): Promise<void> {
    const stored = await this.protectForWrite(record, record.credentialVersion)
    await this.db.insertInto('provider_credentials').values({
      id: record.id,
      provider_id: record.providerId,
      storage_kind: stored.storageKind,
      secret_payload: stored.secretPayload,
      key_version: stored.keyVersion,
      credential_version: record.credentialVersion,
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
    const current = await this.db
      .selectFrom('provider_credentials')
      .select(['credential_version'])
      .where('id', '=', credentialId)
      .where('provider_id', '=', providerId)
      .executeTakeFirst()
    if (!current) return false
    const credentialVersion = current.credential_version + 1
    const stored = await this.protectForWrite({
      id: credentialId,
      providerId,
      storageKind: options.storageKind,
      secretPayload: options.secretPayload,
      keyVersion: null,
      credentialVersion,
      createdAt: options.updatedAt,
      updatedAt: options.updatedAt
    }, credentialVersion)
    const result = await this.db
      .updateTable('provider_credentials')
      .set({
        storage_kind: stored.storageKind,
        secret_payload: stored.secretPayload,
        key_version: stored.keyVersion,
        credential_version: credentialVersion,
        updated_at: options.updatedAt
      })
      .where('id', '=', credentialId)
      .where('provider_id', '=', providerId)
      .where('credential_version', '=', current.credential_version)
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

  async listProviderModelUsageSummaries(): Promise<ProviderModelUsageSummary[]> {
    const rows = await this.db
      .selectFrom('usage_records')
      .select(['provider_id', 'model_id', 'input_tokens', 'output_tokens'])
      .execute()
    const summaries = new Map<string, {
      providerId: string
      modelId: string
      requests: number
      inputTokens: number
      outputTokens: number
    }>()
    for (const row of rows) {
      const key = `${row.provider_id}\u0000${row.model_id}`
      const current = summaries.get(key) || {
        providerId: row.provider_id,
        modelId: row.model_id,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0
      }
      current.requests += 1
      current.inputTokens += row.input_tokens
      current.outputTokens += row.output_tokens
      summaries.set(key, current)
    }
    return [...summaries.values()]
  }

  async listConsoleUsageRecords(since: string): Promise<ProviderConsoleUsageRecord[]> {
    const rows = await this.db
      .selectFrom('usage_records')
      .select([
        'provider_id',
        'account_id',
        'model_id',
        'input_tokens',
        'output_tokens',
        'completed_at'
      ])
      .where('completed_at', '>=', since)
      .orderBy('completed_at', 'asc')
      .execute()
    return rows.map(row => ({
      providerId: row.provider_id,
      accountId: row.account_id,
      modelId: row.model_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      completedAt: row.completed_at
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

  async countEnvelopeCredentials(): Promise<number> {
    const row = await this.db
      .selectFrom('provider_credentials')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('storage_kind', '=', 'envelope-v1')
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async migratePlaintextCredential(
    providerId: string,
    credentialId: string,
    updatedAt: string
  ): Promise<'migrated' | 'skipped'> {
    if (!this.credentialProtector) {
      throw new Error('Credential migration requires a credential protector')
    }
    const current = (await this.listStoredCredentials(providerId))
      .find(record => record.id === credentialId)
    if (!current || current.storageKind === 'envelope-v1') return 'skipped'
    const stored = await this.credentialProtector.protect({
      id: current.id,
      providerId: current.providerId,
      credentialVersion: current.credentialVersion
    }, current.secretPayload)
    const verified = await this.credentialProtector.reveal({
      id: current.id,
      providerId: current.providerId,
      credentialVersion: current.credentialVersion
    }, stored)
    if (verified !== current.secretPayload) {
      throw new Error('Credential migration read-back verification failed')
    }
    const result = await this.db
      .updateTable('provider_credentials')
      .set({
        storage_kind: stored.storageKind,
        secret_payload: stored.secretPayload,
        key_version: stored.keyVersion,
        updated_at: updatedAt
      })
      .where('id', '=', credentialId)
      .where('provider_id', '=', providerId)
      .where('storage_kind', '=', 'plaintext-v1')
      .where('credential_version', '=', current.credentialVersion)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1 ? 'migrated' : 'skipped'
  }

  async rewrapCredential(
    providerId: string,
    credentialId: string,
    updatedAt: string
  ): Promise<'rewrapped' | 'skipped'> {
    if (!this.credentialProtector) {
      throw new Error('Credential rotation requires a credential protector')
    }
    const current = (await this.listStoredCredentials(providerId))
      .find(record => record.id === credentialId)
    if (!current || current.storageKind !== 'envelope-v1') return 'skipped'
    const targetKeyVersion = await this.credentialProtector.currentKeyVersion()
    if (current.keyVersion === targetKeyVersion) return 'skipped'
    const identity = {
      id: current.id,
      providerId: current.providerId,
      credentialVersion: current.credentialVersion
    }
    const stored = await this.credentialProtector.rewrap(identity, {
      storageKind: 'envelope-v1',
      keyVersion: current.keyVersion,
      secretPayload: current.secretPayload
    })
    await this.credentialProtector.reveal(identity, stored)
    const result = await this.db
      .updateTable('provider_credentials')
      .set({
        secret_payload: stored.secretPayload,
        key_version: stored.keyVersion,
        updated_at: updatedAt
      })
      .where('id', '=', credentialId)
      .where('provider_id', '=', providerId)
      .where('storage_kind', '=', 'envelope-v1')
      .where('key_version', '=', current.keyVersion)
      .where('credential_version', '=', current.credentialVersion)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1 ? 'rewrapped' : 'skipped'
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

  private async protectForWrite(
    record: ProviderCredentialRecord,
    credentialVersion: number
  ): Promise<StoredCredentialSecret | {
    storageKind: 'plaintext-v1'
    keyVersion: null
    secretPayload: string
  }> {
    if (!this.credentialProtector) {
      if (record.storageKind === 'envelope-v1') {
        throw new Error('Encrypted credential writes require a credential protector')
      }
      return {
        storageKind: 'plaintext-v1',
        keyVersion: null,
        secretPayload: record.secretPayload
      }
    }
    return this.credentialProtector.protect({
      id: record.id,
      providerId: record.providerId,
      credentialVersion
    }, record.secretPayload)
  }
}
