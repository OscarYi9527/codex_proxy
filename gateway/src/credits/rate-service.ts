import type { AccessIdentity } from '../auth/types.js'
import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  CreditRepository,
  type ModelRateRecord
} from '../db/repositories/credit-repository.js'
import {
  addCredits,
  creditsForTokens,
  formatCredits,
  normalizeCredits,
  parseCredits
} from './decimal.js'

const DEFAULT_RATE = {
  inputCreditPerToken: '0.001000',
  outputCreditPerToken: '0.002000',
  multiplier: '1.000000'
}

export class RateService {
  constructor(
    private readonly repository: CreditRepository,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async rate(modelId: string, at = this.clock.now().toISOString()): Promise<ModelRateRecord> {
    return await this.repository.findEffectiveRate(modelId, at) || {
      id: 'rate_default',
      modelId,
      ...DEFAULT_RATE,
      effectiveFrom: '1970-01-01T00:00:00.000Z',
      effectiveTo: null,
      visibleTo: 'level1'
    }
  }

  async quote(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    rounding: 'ceil' | 'nearest' = 'nearest',
    at = this.clock.now().toISOString()
  ): Promise<{
    inputCredits: string
    outputCredits: string
    totalCredits: string
    rate: ModelRateRecord
  }> {
    const rate = await this.rate(modelId, at)
    const input = creditsForTokens(
      rate.inputCreditPerToken,
      inputTokens,
      rate.multiplier,
      rounding
    )
    const output = creditsForTokens(
      rate.outputCreditPerToken,
      outputTokens,
      rate.multiplier,
      rounding
    )
    return {
      inputCredits: formatCredits(input),
      outputCredits: formatCredits(output),
      totalCredits: formatCredits(addCredits(input, output)),
      rate
    }
  }

  async setModelRate(identity: AccessIdentity, input: {
    modelId: string
    inputCreditPerToken: string | number
    outputCreditPerToken: string | number
    multiplier: string | number
  }): Promise<ModelRateRecord> {
    if (identity.role !== 'level1') {
      throw new SafeError({
        code: 'forbidden',
        message: '仅一级管理员可以设置模型费率。',
        statusCode: 403
      })
    }
    const modelId = input.modelId.trim()
    if (!modelId || modelId.length > 240) {
      throw new SafeError({
        code: 'model_rate_invalid',
        message: '模型费率标识无效。',
        statusCode: 400
      })
    }
    let inputCreditPerToken: string
    let outputCreditPerToken: string
    let multiplier: string
    try {
      inputCreditPerToken = normalizeCredits(input.inputCreditPerToken)
      outputCreditPerToken = normalizeCredits(input.outputCreditPerToken)
      multiplier = normalizeCredits(input.multiplier)
      if (parseCredits(multiplier) <= 0n) throw new Error('non-positive multiplier')
    } catch {
      throw new SafeError({
        code: 'model_rate_invalid',
        message: '模型费率必须是非负数，倍率必须大于零。',
        statusCode: 400
      })
    }
    const now = this.clock.now().toISOString()
    const record: ModelRateRecord = {
      id: this.ids.opaque('rate'),
      modelId,
      inputCreditPerToken,
      outputCreditPerToken,
      multiplier,
      effectiveFrom: now,
      effectiveTo: null,
      visibleTo: 'level1'
    }
    await this.repository.inTransaction(repository =>
      repository.replaceModelRate(record, now)
    )
    return record
  }

  async visibleRates(identity: AccessIdentity): Promise<ModelRateRecord[]> {
    if (identity.role !== 'level1') return []
    return this.repository.listEffectiveRates(this.clock.now().toISOString())
  }
}

