import type { AccessIdentity } from '../auth/types.js'
import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import {
  CreditRepository,
  type TurnRiskRecord
} from '../db/repositories/credit-repository.js'
import { CreditService } from './credit-service.js'
import {
  formatCredits,
  parseCredits
} from './decimal.js'
import { RiskEstimator } from './risk-estimator.js'

const operationQueues = new Map<string, Promise<void>>()

export async function serializeCreditOperation<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = operationQueues.get(key) || Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const marker = previous.catch(() => undefined).then(() => gate)
  operationQueues.set(key, marker)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (operationQueues.get(key) === marker) operationQueues.delete(key)
  }
}

export function evaluateRiskPolicy(input: {
  availableCredits: string
  activeRiskCredits: string
  turnRiskCredits: string
  maxOverdraftPerTurn: string
  maxCumulativeRisk: string
}): {
  projectedAvailableCredits: string
  projectedCumulativeRisk: string
} {
  const active = parseCredits(input.activeRiskCredits)
  const turn = parseCredits(input.turnRiskCredits)
  const available = parseCredits(input.availableCredits, { allowNegative: true })
  const projectedAvailable = available - active - turn
  const projectedCumulative = active + turn
  if (
    projectedAvailable < -parseCredits(input.maxOverdraftPerTurn) ||
    projectedCumulative > parseCredits(input.maxCumulativeRisk)
  ) {
    throw new SafeError({
      code: 'credits_risk_limit',
      message: '该请求超过当前账号允许的新 Turn 风险额度。',
      statusCode: 409,
      retryable: false
    })
  }
  return {
    projectedAvailableCredits: formatCredits(projectedAvailable),
    projectedCumulativeRisk: formatCredits(projectedCumulative)
  }
}

export class TurnRiskService {
  constructor(
    private readonly repository: CreditRepository,
    private readonly credits: CreditService,
    private readonly estimator: RiskEstimator,
    private readonly clock: Clock
  ) {}

  async reserve(input: {
    identity: AccessIdentity
    turnId: string
    modelId: string
    body: Record<string, unknown>
  }): Promise<TurnRiskRecord | null> {
    if (!input.identity.organizationId) return null
    const estimate = await this.estimator.estimate(input.modelId, input.body)
    const organizationId = input.identity.organizationId
    await this.credits.ensureCurrentPeriod(organizationId)
    return serializeCreditOperation(`account:${input.identity.accountId}`, async () => {
      const account = await this.credits.accountCredits(input.identity.accountId)
      if (!account.periodId) {
        throw new SafeError({
          code: 'credits_unavailable',
          message: '账号当前没有可用积分周期。',
          statusCode: 409
        })
      }
      const policy = await this.credits.riskPolicy(organizationId)
      return this.repository.inTransaction(async repository => {
        const existing = await repository.findTurnRisk(input.turnId)
        if (existing) {
          if (
            existing.accountId !== input.identity.accountId ||
            existing.organizationId !== organizationId ||
            existing.deviceSessionId !== input.identity.deviceSessionId ||
            existing.modelId !== input.modelId
          ) {
            throw new SafeError({
              code: 'turn_id_conflict',
              message: 'Turn ID 已绑定到其他请求。',
              statusCode: 409
            })
          }
          return existing
        }
        const activeRiskCredits =
          await repository.activeRiskCredits(input.identity.accountId)
        evaluateRiskPolicy({
          availableCredits: account.available,
          activeRiskCredits,
          turnRiskCredits: estimate.reservedRiskCredits,
          ...policy
        })
        const now = this.clock.now().toISOString()
        const record: TurnRiskRecord = {
          turnId: input.turnId,
          accountId: input.identity.accountId,
          organizationId,
          deviceSessionId: input.identity.deviceSessionId,
          modelId: input.modelId,
          estimatedInputTokens: estimate.estimatedInputTokens,
          maxOutputTokens: estimate.maxOutputTokens,
          reservedRiskCredits: estimate.reservedRiskCredits,
          status: 'reserved',
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          usageRecordId: null,
          failureCode: null
        }
        await repository.insertTurnRisk(record)
        return record
      })
    })
  }

  async markStreaming(turnId: string): Promise<void> {
    const record = await this.repository.findTurnRisk(turnId)
    if (!record) return
    await serializeCreditOperation(`account:${record.accountId}`, () =>
      this.repository.markTurnStreaming(turnId, this.clock.now().toISOString())
    )
  }

  async fail(turnId: string, code: string): Promise<void> {
    const record = await this.repository.findTurnRisk(turnId)
    if (!record) return
    await serializeCreditOperation(`account:${record.accountId}`, () =>
      this.repository.markTurnFailed(turnId, this.clock.now().toISOString(), code)
    )
  }
}
