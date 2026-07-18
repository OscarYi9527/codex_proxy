import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  CreditRepository,
  type UsageRecord
} from '../db/repositories/credit-repository.js'
import { RateService } from './rate-service.js'
import { serializeCreditOperation } from './turn-risk-service.js'

export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

function validTokens(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export class SettlementService {
  constructor(
    private readonly repository: CreditRepository,
    private readonly rates: RateService,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async settle(turnId: string, result: {
    providerId?: string
    usage?: TurnUsage
    routeErrorCode?: string | null
  } = {}): Promise<UsageRecord | null> {
    const initial = await this.repository.findTurnRisk(turnId)
    if (!initial) return null
    return serializeCreditOperation(`account:${initial.accountId}`, async () => {
      const usageSource = result.usage ? 'upstream' : 'estimated'
      const inputTokens = result.usage
        ? validTokens(result.usage.inputTokens)
        : initial.estimatedInputTokens
      const outputTokens = result.usage
        ? validTokens(result.usage.outputTokens)
        : initial.maxOutputTokens
      const quote = await this.rates.quote(
        initial.modelId,
        inputTokens,
        outputTokens,
        'nearest',
        initial.createdAt
      )
      return this.repository.inTransaction(async repository => {
        const existingUsage = await repository.findUsageByTurn(turnId)
        if (existingUsage) return existingUsage
        const risk = await repository.findTurnRisk(turnId)
        if (!risk) return null
        if (risk.status === 'failed' || risk.status === 'abandoned') return null
        const period = await repository.findPeriodAt(
          risk.organizationId,
          risk.createdAt
        )
        if (!period) {
          throw new SafeError({
            code: 'credits_unavailable',
            message: 'Turn 对应的积分周期不存在。',
            statusCode: 409
          })
        }
        const providerId = result.providerId ||
          await repository.resolveProviderIdForModel(risk.modelId)
        if (!providerId) {
          throw new SafeError({
            code: 'provider_unavailable',
            message: '无法确认本次请求的结算 Provider。',
            statusCode: 409
          })
        }
        const now = this.clock.now().toISOString()
        const usage: UsageRecord = {
          id: this.ids.opaque('usage'),
          turnId,
          accountId: risk.accountId,
          organizationId: risk.organizationId,
          periodId: period.id,
          modelId: risk.modelId,
          providerId,
          inputTokens,
          outputTokens,
          usageSource,
          inputCredits: quote.inputCredits,
          outputCredits: quote.outputCredits,
          totalCredits: quote.totalCredits,
          startedAt: risk.startedAt || risk.createdAt,
          completedAt: now,
          routeErrorCode: result.routeErrorCode?.slice(0, 120) || null
        }
        await repository.insertUsage(usage)
        await repository.addSettledCredits(period.id, risk.accountId, usage.totalCredits)
        await repository.markTurnSettled(turnId, usage.id, now)
        return usage
      })
    })
  }
}
