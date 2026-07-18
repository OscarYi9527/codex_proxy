import type { AccessIdentity } from '../auth/types.js'
import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  CreditRepository,
  type CreditPeriodRecord,
  type UsageRecord
} from '../db/repositories/credit-repository.js'
import {
  addCredits,
  formatCredits,
  normalizeCredits,
  parseCredits
} from './decimal.js'

const DEFAULT_MAX_OVERDRAFT_PER_TURN = '100.000000'
const DEFAULT_MAX_CUMULATIVE_RISK = '500.000000'

function localParts(instantMs: number, timeZone: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(instantMs))
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(part => part.type === type)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second')
  }
}

function localDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number
): number {
  const localAsUtc = Date.UTC(year, month - 1, day)
  let candidate = localAsUtc
  for (let index = 0; index < 3; index += 1) {
    const parts = localParts(candidate, timeZone)
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    )
    candidate = localAsUtc - (represented - candidate)
  }
  return candidate
}

export function monthlyBounds(instantMs: number, timeZone: string): {
  periodStart: string
  periodEnd: string
} {
  let parts: ReturnType<typeof localParts>
  try {
    parts = localParts(instantMs, timeZone)
  } catch {
    throw new SafeError({
      code: 'billing_timezone_invalid',
      message: '组织计费时区无效。',
      statusCode: 500
    })
  }
  const nextMonth = parts.month === 12
    ? { year: parts.year + 1, month: 1 }
    : { year: parts.year, month: parts.month + 1 }
  return {
    periodStart: new Date(localDateTimeToUtc(
      timeZone,
      parts.year,
      parts.month,
      1
    )).toISOString(),
    periodEnd: new Date(localDateTimeToUtc(
      timeZone,
      nextMonth.year,
      nextMonth.month,
      1
    )).toISOString()
  }
}

function assertLevel1(identity: AccessIdentity): void {
  if (identity.role !== 'level1') {
    throw new SafeError({
      code: 'forbidden',
      message: '仅一级管理员可以修改该积分策略。',
      statusCode: 403
    })
  }
}

function assertOrganizationScope(
  identity: AccessIdentity,
  organizationId: string
): void {
  if (
    identity.role === 'user' ||
    (identity.role === 'level2' && identity.organizationId !== organizationId)
  ) {
    throw new SafeError({
      code: 'forbidden',
      message: '无权访问该组织的积分数据。',
      statusCode: 403
    })
  }
}

function usageSummary(records: readonly UsageRecord[]): {
  requests: number
  inputTokens: number
  outputTokens: number
  settledCredits: string
} {
  return {
    requests: records.length,
    inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    settledCredits: formatCredits(records.reduce(
      (sum, record) => sum + parseCredits(record.totalCredits, { allowNegative: true }),
      0n
    ))
  }
}

export class CreditService {
  #periodQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly repository: CreditRepository,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  ensureCurrentPeriod(organizationId: string): Promise<CreditPeriodRecord> {
    const operation = this.#periodQueue.then(() => this.createCurrentPeriod(organizationId))
    this.#periodQueue = operation.catch(() => undefined)
    return operation
  }

  private async createCurrentPeriod(organizationId: string): Promise<CreditPeriodRecord> {
    const organization = await this.repository.findOrganization(organizationId)
    if (!organization) throw this.organizationNotFound()
    const bounds = monthlyBounds(this.clock.nowMs(), organization.billingTimezone)
    const existing = await this.repository.findPeriodAt(
      organizationId,
      this.clock.now().toISOString()
    )
    if (existing) return existing
    return this.repository.inTransaction(async repository => {
      const inside = await repository.findPeriodAt(
        organizationId,
        this.clock.now().toISOString()
      )
      if (inside) return inside
      const previous = await repository.findLatestPeriodBefore(
        organizationId,
        bounds.periodStart
      )
      const now = this.clock.now().toISOString()
      const record: CreditPeriodRecord = {
        id: this.ids.opaque('period'),
        organizationId,
        periodStart: bounds.periodStart,
        periodEnd: bounds.periodEnd,
        allocatedCredits: previous?.allocatedCredits || '0.000000',
        settledCredits: '0.000000',
        createdAt: now,
        closedAt: null,
        version: 1
      }
      await repository.insertPeriod(record)
      const created = await repository.findPeriodAt(organizationId, now)
      if (!created) throw new Error('Current credit period was not created')
      if (previous) {
        const allocations = await repository.listAllocations(previous.id)
        for (const item of allocations) {
          await repository.upsertAllocation({
            periodId: created.id,
            accountId: item.accountId,
            allocatedCredits: item.allocatedCredits,
            settledCredits: '0.000000',
            updatedBy: item.updatedBy,
            updatedAt: now,
            version: 1
          })
        }
      }
      await repository.closePeriodsBefore(organizationId, bounds.periodStart, now)
      return created
    })
  }

  async setMonthlyCredits(
    identity: AccessIdentity,
    organizationId: string,
    value: string | number
  ): Promise<CreditPeriodRecord> {
    assertLevel1(identity)
    const credits = this.validCredits(value)
    const current = await this.ensureCurrentPeriod(organizationId)
    return this.repository.inTransaction(async repository => {
      const allocatedUsers = await repository.allocatedUserCredits(current.id)
      if (parseCredits(credits) < parseCredits(allocatedUsers)) {
        throw new SafeError({
          code: 'credit_allocation_exceeds_pool',
          message: '组织月度总积分不能低于已分配给用户的积分。',
          statusCode: 409
        })
      }
      await repository.updatePeriodAllocation(current.id, credits)
      const updated = await repository.findPeriodById(current.id)
      if (!updated) throw new Error('Updated credit period is missing')
      return updated
    })
  }

  async setUserAllocation(
    identity: AccessIdentity,
    accountId: string,
    value: string | number
  ): Promise<void> {
    const credits = this.validCredits(value)
    const account = await this.repository.findAccount(accountId)
    if (!account?.organizationId) {
      throw new SafeError({
        code: 'account_not_found',
        message: '未找到可分配积分的组织用户。',
        statusCode: 404
      })
    }
    assertOrganizationScope(identity, account.organizationId)
    if (identity.role === 'level2' && account.role !== 'user') {
      throw new SafeError({
        code: 'forbidden',
        message: '二级管理员只能分配普通用户积分。',
        statusCode: 403
      })
    }
    const current = await this.ensureCurrentPeriod(account.organizationId)
    await this.repository.inTransaction(async repository => {
      const existing = await repository.findAllocation(current.id, accountId)
      const total = parseCredits(await repository.allocatedUserCredits(current.id))
      const old = existing ? parseCredits(existing.allocatedCredits) : 0n
      const projected = total - old + parseCredits(credits)
      if (projected > parseCredits(current.allocatedCredits)) {
        throw new SafeError({
          code: 'credit_allocation_exceeds_pool',
          message: '用户积分分配总额超过组织月度总积分。',
          statusCode: 409
        })
      }
      await repository.upsertAllocation({
        periodId: current.id,
        accountId,
        allocatedCredits: credits,
        settledCredits: existing?.settledCredits || '0.000000',
        updatedBy: identity.accountId,
        updatedAt: this.clock.now().toISOString(),
        version: existing?.version || 1
      })
    })
  }

  async setRiskPolicy(
    identity: AccessIdentity,
    organizationId: string,
    input: {
      maxOverdraftPerTurn: string | number
      maxCumulativeRisk: string | number
    }
  ): Promise<void> {
    assertLevel1(identity)
    if (!await this.repository.findOrganization(organizationId)) {
      throw this.organizationNotFound()
    }
    const maxOverdraftPerTurn = this.positiveCredits(input.maxOverdraftPerTurn)
    const maxCumulativeRisk = this.positiveCredits(input.maxCumulativeRisk)
    await this.repository.upsertRiskPolicy({
      scope: organizationId,
      maxOverdraftPerTurn,
      maxCumulativeRisk,
      updatedBy: identity.accountId,
      updatedAt: this.clock.now().toISOString()
    })
  }

  async riskPolicy(organizationId: string): Promise<{
    maxOverdraftPerTurn: string
    maxCumulativeRisk: string
  }> {
    const organization = await this.repository.findOrganization(organizationId)
    if (!organization) throw this.organizationNotFound()
    const scoped = await this.repository.findRiskPolicy(organizationId)
    const global = await this.repository.findRiskPolicy('global')
    return {
      maxOverdraftPerTurn: normalizeCredits(
        organization.overdraftPerTurnOverride ||
          scoped?.maxOverdraftPerTurn ||
          global?.maxOverdraftPerTurn ||
          DEFAULT_MAX_OVERDRAFT_PER_TURN
      ),
      maxCumulativeRisk: normalizeCredits(
        organization.cumulativeRiskOverride ||
          scoped?.maxCumulativeRisk ||
          global?.maxCumulativeRisk ||
          DEFAULT_MAX_CUMULATIVE_RISK
      )
    }
  }

  async accountCredits(accountId: string): Promise<{
    periodId: string | null
    periodStart: string | null
    periodEnd: string | null
    allocated: string
    settled: string
    available: string
  }> {
    const account = await this.repository.findAccount(accountId)
    if (!account?.organizationId) return this.emptyAccountCredits()
    const current = await this.ensureCurrentPeriod(account.organizationId)
    const allocation = await this.repository.findAllocation(current.id, accountId)
    const allocated = allocation?.allocatedCredits || '0.000000'
    const settled = allocation?.settledCredits || '0.000000'
    return {
      periodId: current.id,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      allocated,
      settled,
      available: formatCredits(addCredits(
        parseCredits(allocated),
        -parseCredits(settled, { allowNegative: true })
      ))
    }
  }

  async organizationView(
    identity: AccessIdentity,
    organizationId: string
  ): Promise<{
    organization: { id: string; name: string }
    period: {
      id: string
      periodStart: string
      periodEnd: string
      allocated: string
      settled: string
      available: string
    }
    users: Array<{
      accountId: string
      display: string
      allocated: string
      settled: string
      available: string
      requests: number
      inputTokens: number
      outputTokens: number
    }>
    usage: ReturnType<typeof usageSummary>
    riskPolicy?: {
      maxOverdraftPerTurn: string
      maxCumulativeRisk: string
      activeRiskCredits: string
    }
  }> {
    assertOrganizationScope(identity, organizationId)
    const organization = await this.repository.findOrganization(organizationId)
    if (!organization) throw this.organizationNotFound()
    const current = await this.ensureCurrentPeriod(organizationId)
    const accounts = await this.repository.listOrganizationAccounts(organizationId)
    const records = await this.repository.listUsage({
      organizationId,
      periodId: current.id
    })
    const users = await Promise.all(accounts.map(async account => {
      const item = await this.repository.findAllocation(current.id, account.id)
      const allocated = item?.allocatedCredits || '0.000000'
      const settled = item?.settledCredits || '0.000000'
      const accountUsage = records.filter(record => record.accountId === account.id)
      const summary = usageSummary(accountUsage)
      return {
        accountId: account.id,
        display: account.display,
        allocated,
        settled,
        available: formatCredits(addCredits(
          parseCredits(allocated),
          -parseCredits(settled, { allowNegative: true })
        )),
        requests: summary.requests,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens
      }
    }))
    const result: Awaited<ReturnType<CreditService['organizationView']>> = {
      organization: { id: organization.id, name: organization.name },
      period: {
        id: current.id,
        periodStart: current.periodStart,
        periodEnd: current.periodEnd,
        allocated: current.allocatedCredits,
        settled: current.settledCredits,
        available: formatCredits(addCredits(
          parseCredits(current.allocatedCredits),
          -parseCredits(current.settledCredits, { allowNegative: true })
        ))
      },
      users,
      usage: usageSummary(records)
    }
    if (identity.role === 'level1') {
      result.riskPolicy = {
        ...await this.riskPolicy(organizationId),
        activeRiskCredits:
          await this.repository.activeOrganizationRiskCredits(organizationId)
      }
    }
    return result
  }

  async accountUsage(identity: AccessIdentity, accountId: string): Promise<{
    summary: ReturnType<typeof usageSummary>
    records: Array<{
      id: string
      turnId: string
      modelId: string
      inputTokens: number
      outputTokens: number
      totalCredits: string
      usageSource: 'upstream' | 'estimated'
      completedAt: string
    }>
  }> {
    if (identity.accountId !== accountId) {
      throw new SafeError({
        code: 'forbidden',
        message: '无权查看该账号用量。',
        statusCode: 403
      })
    }
    const account = await this.repository.findAccount(accountId)
    if (!account) {
      throw new SafeError({
        code: 'account_not_found',
        message: '未找到账号。',
        statusCode: 404
      })
    }
    const current = account.organizationId
      ? await this.ensureCurrentPeriod(account.organizationId)
      : null
    const records = await this.repository.listUsage({
      accountId,
      ...(current ? { periodId: current.id } : {})
    })
    return {
      summary: usageSummary(records),
      records: records.map(record => ({
        id: record.id,
        turnId: record.turnId,
        modelId: record.modelId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalCredits: record.totalCredits,
        usageSource: record.usageSource,
        completedAt: record.completedAt
      }))
    }
  }

  async organizationUsage(
    identity: AccessIdentity,
    organizationId: string
  ): Promise<ReturnType<typeof usageSummary>> {
    assertOrganizationScope(identity, organizationId)
    const current = await this.ensureCurrentPeriod(organizationId)
    return usageSummary(await this.repository.listUsage({
      organizationId,
      periodId: current.id
    }))
  }

  private validCredits(value: string | number): string {
    try {
      return normalizeCredits(value)
    } catch {
      throw new SafeError({
        code: 'credit_value_invalid',
        message: '积分必须是最多六位小数的非负数。',
        statusCode: 400
      })
    }
  }

  private positiveCredits(value: string | number): string {
    const credits = this.validCredits(value)
    if (parseCredits(credits) <= 0n) {
      throw new SafeError({
        code: 'credit_value_invalid',
        message: '风险额度必须大于零。',
        statusCode: 400
      })
    }
    return credits
  }

  private emptyAccountCredits() {
    return {
      periodId: null,
      periodStart: null,
      periodEnd: null,
      allocated: '0.000000',
      settled: '0.000000',
      available: '0.000000'
    }
  }

  private organizationNotFound(): SafeError {
    return new SafeError({
      code: 'organization_not_found',
      message: '未找到组织。',
      statusCode: 404
    })
  }
}
