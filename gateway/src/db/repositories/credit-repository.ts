import type { Kysely, Transaction } from 'kysely'
import type { AccountRole } from '../../auth/types.js'
import { addCredits, formatCredits, parseCredits } from '../../credits/decimal.js'
import type { GatewayDatabase } from '../schema.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>

export interface OrganizationBillingRecord {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'disabled'
  readonly billingTimezone: string
  readonly overdraftPerTurnOverride: string | null
  readonly cumulativeRiskOverride: string | null
}

export interface AccountBillingRecord {
  readonly id: string
  readonly display: string
  readonly role: AccountRole
  readonly status: 'active' | 'disabled' | 'expired'
  readonly organizationId: string | null
}

export interface CreditPeriodRecord {
  readonly id: string
  readonly organizationId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly allocatedCredits: string
  readonly settledCredits: string
  readonly createdAt: string
  readonly closedAt: string | null
  readonly version: number
}

export interface UserCreditAllocationRecord {
  readonly periodId: string
  readonly accountId: string
  readonly allocatedCredits: string
  readonly settledCredits: string
  readonly updatedBy: string
  readonly updatedAt: string
  readonly version: number
}

export interface ModelRateRecord {
  readonly id: string
  readonly modelId: string
  readonly inputCreditPerToken: string
  readonly outputCreditPerToken: string
  readonly multiplier: string
  readonly effectiveFrom: string
  readonly effectiveTo: string | null
  readonly visibleTo: string
}

export interface RiskPolicyRecord {
  readonly scope: string
  readonly maxOverdraftPerTurn: string
  readonly maxCumulativeRisk: string
  readonly updatedBy: string
  readonly updatedAt: string
}

export interface TurnRiskRecord {
  readonly turnId: string
  readonly accountId: string
  readonly organizationId: string
  readonly deviceSessionId: string
  readonly modelId: string
  readonly estimatedInputTokens: number
  readonly maxOutputTokens: number
  readonly reservedRiskCredits: string
  readonly status: 'reserved' | 'streaming' | 'settled' | 'failed' | 'abandoned'
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly usageRecordId: string | null
  readonly failureCode: string | null
}

export interface ExemptTurnRecord {
  readonly turnId: string
  readonly accountId: string
  readonly deviceSessionId: string
  readonly modelId: string
  readonly settlementId: string
  readonly status: 'accepted' | 'streaming' | 'settled' | 'failed'
  readonly providerId: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly failureCode: string | null
}

export interface UsageRecord {
  readonly id: string
  readonly turnId: string
  readonly accountId: string
  readonly organizationId: string
  readonly periodId: string
  readonly modelId: string
  readonly providerId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly usageSource: 'upstream' | 'estimated'
  readonly inputCredits: string
  readonly outputCredits: string
  readonly totalCredits: string
  readonly startedAt: string
  readonly completedAt: string
  readonly routeErrorCode: string | null
}

function period(row: {
  id: string
  organization_id: string
  period_start: string
  period_end: string
  allocated_credits: string
  settled_credits: string
  created_at: string
  closed_at: string | null
  version: number
}): CreditPeriodRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    allocatedCredits: row.allocated_credits,
    settledCredits: row.settled_credits,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    version: row.version
  }
}

function allocation(row: {
  period_id: string
  account_id: string
  allocated_credits: string
  settled_credits: string
  updated_by: string
  updated_at: string
  version: number
}): UserCreditAllocationRecord {
  return {
    periodId: row.period_id,
    accountId: row.account_id,
    allocatedCredits: row.allocated_credits,
    settledCredits: row.settled_credits,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    version: row.version
  }
}

function turnRisk(row: {
  turn_id: string
  account_id: string
  organization_id: string
  device_session_id: string
  model_id: string
  estimated_input_tokens: number
  max_output_tokens: number
  reserved_risk_credits: string
  status: TurnRiskRecord['status']
  created_at: string
  started_at: string | null
  finished_at: string | null
  usage_record_id: string | null
  failure_code: string | null
}): TurnRiskRecord {
  return {
    turnId: row.turn_id,
    accountId: row.account_id,
    organizationId: row.organization_id,
    deviceSessionId: row.device_session_id,
    modelId: row.model_id,
    estimatedInputTokens: row.estimated_input_tokens,
    maxOutputTokens: row.max_output_tokens,
    reservedRiskCredits: row.reserved_risk_credits,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usageRecordId: row.usage_record_id,
    failureCode: row.failure_code
  }
}

function exemptTurn(row: {
  turn_id: string
  account_id: string
  device_session_id: string
  model_id: string
  settlement_id: string
  status: ExemptTurnRecord['status']
  provider_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  failure_code: string | null
}): ExemptTurnRecord {
  return {
    turnId: row.turn_id,
    accountId: row.account_id,
    deviceSessionId: row.device_session_id,
    modelId: row.model_id,
    settlementId: row.settlement_id,
    status: row.status,
    providerId: row.provider_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureCode: row.failure_code
  }
}

export class CreditRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  inTransaction<T>(callback: (repository: CreditRepository) => Promise<T>): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('Credit repository transaction boundary is unavailable')
    }
    return this.transactionRunner(transaction =>
      callback(new CreditRepository(transaction))
    )
  }

  async findOrganization(organizationId: string): Promise<OrganizationBillingRecord | null> {
    const row = await this.db.selectFrom('organizations')
      .select([
        'id',
        'name',
        'status',
        'billing_timezone',
        'overdraft_per_turn_override',
        'cumulative_risk_override'
      ])
      .where('id', '=', organizationId)
      .executeTakeFirst()
    return row ? {
      id: row.id,
      name: row.name,
      status: row.status,
      billingTimezone: row.billing_timezone,
      overdraftPerTurnOverride: row.overdraft_per_turn_override,
      cumulativeRiskOverride: row.cumulative_risk_override
    } : null
  }

  async findAccount(accountId: string): Promise<AccountBillingRecord | null> {
    const row = await this.db.selectFrom('accounts')
      .select(['id', 'login_name', 'email', 'role', 'status', 'organization_id'])
      .where('id', '=', accountId)
      .executeTakeFirst()
    return row ? {
      id: row.id,
      display: row.email || row.login_name || row.id,
      role: row.role,
      status: row.status,
      organizationId: row.organization_id
    } : null
  }

  async listOrganizationAccounts(organizationId: string): Promise<AccountBillingRecord[]> {
    const rows = await this.db.selectFrom('accounts')
      .select(['id', 'login_name', 'email', 'role', 'status', 'organization_id'])
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map(row => ({
      id: row.id,
      display: row.email || row.login_name || row.id,
      role: row.role,
      status: row.status,
      organizationId: row.organization_id
    }))
  }

  async findPeriodById(periodId: string): Promise<CreditPeriodRecord | null> {
    const row = await this.db.selectFrom('organization_credit_periods')
      .selectAll()
      .where('id', '=', periodId)
      .executeTakeFirst()
    return row ? period(row) : null
  }

  async findPeriodAt(
    organizationId: string,
    instant: string
  ): Promise<CreditPeriodRecord | null> {
    const row = await this.db.selectFrom('organization_credit_periods')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('period_start', '<=', instant)
      .where('period_end', '>', instant)
      .orderBy('period_start', 'desc')
      .executeTakeFirst()
    return row ? period(row) : null
  }

  async findLatestPeriodBefore(
    organizationId: string,
    periodStart: string
  ): Promise<CreditPeriodRecord | null> {
    const row = await this.db.selectFrom('organization_credit_periods')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('period_start', '<', periodStart)
      .orderBy('period_start', 'desc')
      .executeTakeFirst()
    return row ? period(row) : null
  }

  async insertPeriod(record: CreditPeriodRecord): Promise<void> {
    await this.db.insertInto('organization_credit_periods').values({
      id: record.id,
      organization_id: record.organizationId,
      period_start: record.periodStart,
      period_end: record.periodEnd,
      allocated_credits: record.allocatedCredits,
      settled_credits: record.settledCredits,
      created_at: record.createdAt,
      closed_at: record.closedAt,
      version: record.version
    }).onConflict(conflict =>
      conflict.columns(['organization_id', 'period_start']).doNothing()
    ).execute()
  }

  async closePeriodsBefore(
    organizationId: string,
    periodStart: string,
    now: string
  ): Promise<void> {
    await this.db.updateTable('organization_credit_periods')
      .set({ closed_at: now })
      .where('organization_id', '=', organizationId)
      .where('period_start', '<', periodStart)
      .where('closed_at', 'is', null)
      .execute()
  }

  async updatePeriodAllocation(periodId: string, credits: string): Promise<void> {
    await this.db.updateTable('organization_credit_periods')
      .set(expression => ({
        allocated_credits: credits,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', periodId)
      .executeTakeFirstOrThrow()
  }

  async listAllocations(periodId: string): Promise<UserCreditAllocationRecord[]> {
    const rows = await this.db.selectFrom('user_credit_allocations')
      .selectAll()
      .where('period_id', '=', periodId)
      .orderBy('account_id', 'asc')
      .execute()
    return rows.map(allocation)
  }

  async findAllocation(
    periodId: string,
    accountId: string
  ): Promise<UserCreditAllocationRecord | null> {
    const row = await this.db.selectFrom('user_credit_allocations')
      .selectAll()
      .where('period_id', '=', periodId)
      .where('account_id', '=', accountId)
      .executeTakeFirst()
    return row ? allocation(row) : null
  }

  async upsertAllocation(record: UserCreditAllocationRecord): Promise<void> {
    await this.db.insertInto('user_credit_allocations').values({
      period_id: record.periodId,
      account_id: record.accountId,
      allocated_credits: record.allocatedCredits,
      settled_credits: record.settledCredits,
      updated_by: record.updatedBy,
      updated_at: record.updatedAt,
      version: record.version
    }).onConflict(conflict =>
      conflict.columns(['period_id', 'account_id']).doUpdateSet(expression => ({
        allocated_credits: expression.ref('excluded.allocated_credits'),
        updated_by: expression.ref('excluded.updated_by'),
        updated_at: expression.ref('excluded.updated_at'),
        version: expression('user_credit_allocations.version', '+', 1)
      }))
    ).execute()
  }

  async allocatedUserCredits(periodId: string): Promise<string> {
    const rows = await this.db.selectFrom('user_credit_allocations')
      .select('allocated_credits')
      .where('period_id', '=', periodId)
      .execute()
    return formatCredits(rows.reduce(
      (sum, row) => sum + parseCredits(row.allocated_credits),
      0n
    ))
  }

  async addSettledCredits(
    periodId: string,
    accountId: string,
    credits: string
  ): Promise<void> {
    const periodRecord = await this.findPeriodById(periodId)
    const userRecord = await this.findAllocation(periodId, accountId)
    if (!periodRecord || !userRecord) throw new Error('Credit settlement scope is missing')
    const settled = formatCredits(addCredits(periodRecord.settledCredits, credits))
    const userSettled = formatCredits(addCredits(userRecord.settledCredits, credits))
    await this.db.updateTable('organization_credit_periods')
      .set(expression => ({
        settled_credits: settled,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', periodId)
      .execute()
    await this.db.updateTable('user_credit_allocations')
      .set(expression => ({
        settled_credits: userSettled,
        version: expression('version', '+', 1)
      }))
      .where('period_id', '=', periodId)
      .where('account_id', '=', accountId)
      .execute()
  }

  async findEffectiveRate(modelId: string, at: string): Promise<ModelRateRecord | null> {
    const row = await this.db.selectFrom('model_rates')
      .selectAll()
      .where('model_id', '=', modelId)
      .where('effective_from', '<=', at)
      .where(query => query.or([
        query('effective_to', 'is', null),
        query('effective_to', '>', at)
      ]))
      .orderBy('effective_from', 'desc')
      .executeTakeFirst()
    return row ? {
      id: row.id,
      modelId: row.model_id,
      inputCreditPerToken: row.input_credit_per_token,
      outputCreditPerToken: row.output_credit_per_token,
      multiplier: row.multiplier,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      visibleTo: row.visible_to
    } : null
  }

  async listEffectiveRates(at: string): Promise<ModelRateRecord[]> {
    const rows = await this.db.selectFrom('model_rates')
      .selectAll()
      .where('effective_from', '<=', at)
      .where(query => query.or([
        query('effective_to', 'is', null),
        query('effective_to', '>', at)
      ]))
      .orderBy('model_id', 'asc')
      .orderBy('effective_from', 'desc')
      .execute()
    const seen = new Set<string>()
    return rows.filter(row => {
      if (seen.has(row.model_id)) return false
      seen.add(row.model_id)
      return true
    }).map(row => ({
      id: row.id,
      modelId: row.model_id,
      inputCreditPerToken: row.input_credit_per_token,
      outputCreditPerToken: row.output_credit_per_token,
      multiplier: row.multiplier,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      visibleTo: row.visible_to
    }))
  }

  async replaceModelRate(record: ModelRateRecord, now: string): Promise<void> {
    await this.db.updateTable('model_rates')
      .set({ effective_to: now })
      .where('model_id', '=', record.modelId)
      .where('effective_to', 'is', null)
      .execute()
    await this.db.insertInto('model_rates').values({
      id: record.id,
      model_id: record.modelId,
      input_credit_per_token: record.inputCreditPerToken,
      output_credit_per_token: record.outputCreditPerToken,
      multiplier: record.multiplier,
      effective_from: record.effectiveFrom,
      effective_to: record.effectiveTo,
      visible_to: record.visibleTo
    }).execute()
  }

  async findRiskPolicy(scope: string): Promise<RiskPolicyRecord | null> {
    const row = await this.db.selectFrom('risk_policies')
      .selectAll()
      .where('scope', '=', scope)
      .executeTakeFirst()
    return row ? {
      scope: row.scope,
      maxOverdraftPerTurn: row.max_overdraft_per_turn,
      maxCumulativeRisk: row.max_cumulative_risk,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at
    } : null
  }

  async upsertRiskPolicy(record: RiskPolicyRecord): Promise<void> {
    await this.db.insertInto('risk_policies').values({
      scope: record.scope,
      max_overdraft_per_turn: record.maxOverdraftPerTurn,
      max_cumulative_risk: record.maxCumulativeRisk,
      updated_by: record.updatedBy,
      updated_at: record.updatedAt
    }).onConflict(conflict => conflict.column('scope').doUpdateSet({
      max_overdraft_per_turn: record.maxOverdraftPerTurn,
      max_cumulative_risk: record.maxCumulativeRisk,
      updated_by: record.updatedBy,
      updated_at: record.updatedAt
    })).execute()
  }

  async findTurnRisk(turnId: string): Promise<TurnRiskRecord | null> {
    const row = await this.db.selectFrom('turn_risks')
      .selectAll()
      .where('turn_id', '=', turnId)
      .executeTakeFirst()
    return row ? turnRisk(row) : null
  }

  async activeRiskCredits(accountId: string): Promise<string> {
    const rows = await this.db.selectFrom('turn_risks')
      .select('reserved_risk_credits')
      .where('account_id', '=', accountId)
      .where('status', 'in', ['reserved', 'streaming'])
      .execute()
    return formatCredits(rows.reduce(
      (sum, row) => sum + parseCredits(row.reserved_risk_credits),
      0n
    ))
  }

  async activeOrganizationRiskCredits(organizationId: string): Promise<string> {
    const rows = await this.db.selectFrom('turn_risks')
      .select('reserved_risk_credits')
      .where('organization_id', '=', organizationId)
      .where('status', 'in', ['reserved', 'streaming'])
      .execute()
    return formatCredits(rows.reduce(
      (sum, row) => sum + parseCredits(row.reserved_risk_credits),
      0n
    ))
  }

  async insertTurnRisk(record: TurnRiskRecord): Promise<void> {
    await this.db.insertInto('turn_risks').values({
      turn_id: record.turnId,
      account_id: record.accountId,
      organization_id: record.organizationId,
      device_session_id: record.deviceSessionId,
      model_id: record.modelId,
      estimated_input_tokens: record.estimatedInputTokens,
      max_output_tokens: record.maxOutputTokens,
      reserved_risk_credits: record.reservedRiskCredits,
      status: record.status,
      created_at: record.createdAt,
      started_at: record.startedAt,
      finished_at: record.finishedAt,
      usage_record_id: record.usageRecordId,
      failure_code: record.failureCode
    }).execute()
  }

  async findExemptTurn(turnId: string): Promise<ExemptTurnRecord | null> {
    const row = await this.db.selectFrom('exempt_turns')
      .selectAll()
      .where('turn_id', '=', turnId)
      .executeTakeFirst()
    return row ? exemptTurn(row) : null
  }

  async insertExemptTurn(record: ExemptTurnRecord): Promise<void> {
    await this.db.insertInto('exempt_turns').values({
      turn_id: record.turnId,
      account_id: record.accountId,
      device_session_id: record.deviceSessionId,
      model_id: record.modelId,
      settlement_id: record.settlementId,
      status: record.status,
      provider_id: record.providerId,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      created_at: record.createdAt,
      started_at: record.startedAt,
      finished_at: record.finishedAt,
      failure_code: record.failureCode
    }).execute()
  }

  async markExemptTurnStreaming(turnId: string, now: string): Promise<void> {
    await this.db.updateTable('exempt_turns')
      .set({ status: 'streaming', started_at: now })
      .where('turn_id', '=', turnId)
      .where('status', '=', 'accepted')
      .execute()
  }

  async markExemptTurnFailed(
    turnId: string,
    now: string,
    failureCode: string
  ): Promise<void> {
    await this.db.updateTable('exempt_turns')
      .set({
        status: 'failed',
        finished_at: now,
        failure_code: failureCode.slice(0, 120)
      })
      .where('turn_id', '=', turnId)
      .where('status', 'in', ['accepted', 'streaming'])
      .execute()
  }

  async markExemptTurnSettled(
    turnId: string,
    input: {
      providerId: string
      inputTokens: number
      outputTokens: number
      now: string
    }
  ): Promise<void> {
    await this.db.updateTable('exempt_turns')
      .set({
        status: 'settled',
        provider_id: input.providerId,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        finished_at: input.now,
        failure_code: null
      })
      .where('turn_id', '=', turnId)
      .where('status', 'in', ['accepted', 'streaming'])
      .execute()
  }

  async markTurnStreaming(turnId: string, now: string): Promise<void> {
    await this.db.updateTable('turn_risks')
      .set({ status: 'streaming', started_at: now })
      .where('turn_id', '=', turnId)
      .where('status', '=', 'reserved')
      .execute()
  }

  async markTurnFailed(turnId: string, now: string, failureCode: string): Promise<void> {
    await this.db.updateTable('turn_risks')
      .set({
        status: 'failed',
        finished_at: now,
        failure_code: failureCode.slice(0, 120)
      })
      .where('turn_id', '=', turnId)
      .where('status', 'in', ['reserved', 'streaming'])
      .execute()
  }

  async markTurnSettled(
    turnId: string,
    usageRecordId: string,
    now: string
  ): Promise<void> {
    await this.db.updateTable('turn_risks')
      .set({
        status: 'settled',
        finished_at: now,
        usage_record_id: usageRecordId,
        failure_code: null
      })
      .where('turn_id', '=', turnId)
      .where('status', 'in', ['reserved', 'streaming'])
      .execute()
  }

  async findUsageByTurn(turnId: string): Promise<UsageRecord | null> {
    const row = await this.db.selectFrom('usage_records')
      .selectAll()
      .where('turn_id', '=', turnId)
      .executeTakeFirst()
    return row ? {
      id: row.id,
      turnId: row.turn_id,
      accountId: row.account_id,
      organizationId: row.organization_id,
      periodId: row.period_id,
      modelId: row.model_id,
      providerId: row.provider_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      usageSource: row.usage_source,
      inputCredits: row.input_credits,
      outputCredits: row.output_credits,
      totalCredits: row.total_credits,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      routeErrorCode: row.route_error_code
    } : null
  }

  async insertUsage(record: UsageRecord): Promise<void> {
    await this.db.insertInto('usage_records').values({
      id: record.id,
      turn_id: record.turnId,
      account_id: record.accountId,
      organization_id: record.organizationId,
      period_id: record.periodId,
      model_id: record.modelId,
      provider_id: record.providerId,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      usage_source: record.usageSource,
      input_credits: record.inputCredits,
      output_credits: record.outputCredits,
      total_credits: record.totalCredits,
      started_at: record.startedAt,
      completed_at: record.completedAt,
      route_error_code: record.routeErrorCode
    }).execute()
  }

  async resolveProviderIdForModel(modelId: string): Promise<string | null> {
    const row = await this.db.selectFrom('model_routes')
      .innerJoin('providers', 'providers.id', 'model_routes.provider_id')
      .select('model_routes.provider_id')
      .where('model_routes.public_model_id', '=', modelId)
      .where('model_routes.enabled', '=', 1)
      .where('providers.status', '=', 'active')
      .orderBy('model_routes.priority', 'asc')
      .executeTakeFirst()
    return row?.provider_id || null
  }

  async listUsage(options: {
    accountId?: string
    organizationId?: string
    periodId?: string
  }): Promise<UsageRecord[]> {
    let query = this.db.selectFrom('usage_records').selectAll()
    if (options.accountId) query = query.where('account_id', '=', options.accountId)
    if (options.organizationId) query = query.where('organization_id', '=', options.organizationId)
    if (options.periodId) query = query.where('period_id', '=', options.periodId)
    const rows = await query.orderBy('completed_at', 'desc').limit(200).execute()
    return rows.map(row => ({
      id: row.id,
      turnId: row.turn_id,
      accountId: row.account_id,
      organizationId: row.organization_id,
      periodId: row.period_id,
      modelId: row.model_id,
      providerId: row.provider_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      usageSource: row.usage_source,
      inputCredits: row.input_credits,
      outputCredits: row.output_credits,
      totalCredits: row.total_credits,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      routeErrorCode: row.route_error_code
    }))
  }
}
