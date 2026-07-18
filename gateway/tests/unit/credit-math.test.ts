import { jest } from '@jest/globals'
import {
  addCredits,
  creditsForTokens,
  formatCredits,
  normalizeCredits,
  parseCredits,
  percentage
} from '../../src/credits/decimal.js'
import { RiskEstimator } from '../../src/credits/risk-estimator.js'
import type { RateService } from '../../src/credits/rate-service.js'
import { RateService as ConcreteRateService } from '../../src/credits/rate-service.js'
import { CreditRepository } from '../../src/db/repositories/credit-repository.js'
import { createCreditDatabase } from '../helpers/credit-fixture.js'
import { MutableClock } from '../helpers/auth-fixture.js'
import { SequenceIdSource } from '../../src/common/ids.js'

describe('fixed precision credit arithmetic', () => {
  it('normalizes, adds and formats positive and negative values', () => {
    expect(normalizeCredits(1.25)).toBe('1.250000')
    expect(formatCredits(addCredits('1.250000', '-0.500000'))).toBe('0.750000')
    expect(parseCredits('-0.500000', { allowNegative: true })).toBe(-500_000n)
    expect(() => parseCredits('-0.1')).toThrow(/non-negative/)
    expect(() => parseCredits('1.0000001')).toThrow(/six decimal/)
    expect(() => parseCredits(Number.NaN)).toThrow(/six decimal/)
  })

  it('applies multipliers with deterministic nearest and ceiling rounding', () => {
    expect(formatCredits(creditsForTokens('0.000001', 1, '0.500000', 'nearest')))
      .toBe('0.000001')
    expect(formatCredits(creditsForTokens('0.000001', 1, '0.100000', 'ceil')))
      .toBe('0.000001')
    expect(formatCredits(creditsForTokens('0.000001', 0, '1'))).toBe('0.000000')
    expect(() => creditsForTokens('1', -1, '1')).toThrow(/Token count/)
  })

  it('formats safe usage percentages for zero, whole and fractional allocations', () => {
    expect(percentage('5', '0')).toBe('0')
    expect(percentage('-1', '10')).toBe('0')
    expect(percentage('5', '10')).toBe('50')
    expect(percentage('1', '3')).toBe('33.3')
  })
})

describe('worst-case Token estimation', () => {
  it('estimates nested Responses and Chat payload text and honors output caps', async () => {
    const quote = jest.fn(async (
      _modelId: string,
      inputTokens: number,
      outputTokens: number
    ) => ({
      inputCredits: '0.000000',
      outputCredits: '0.000000',
      totalCredits: `${inputTokens + outputTokens}.000000`,
      rate: {
        id: 'rate_test',
        modelId: 'model',
        inputCreditPerToken: '1.000000',
        outputCreditPerToken: '1.000000',
        multiplier: '1.000000',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        visibleTo: 'level1'
      }
    }))
    const estimator = new RiskEstimator({ quote } as unknown as RateService)

    const nested = await estimator.estimate('model', {
      messages: [
        { role: 'user', content: '12345678' },
        { content: [{ type: 'input_text', text: '1234' }] }
      ],
      max_completion_tokens: 12
    })
    expect(nested).toEqual({
      estimatedInputTokens: 7,
      maxOutputTokens: 12,
      reservedRiskCredits: '19.000000'
    })

    const capped = await estimator.estimate('model', {
      input: 123,
      max_output_tokens: 999_999
    })
    expect(capped.estimatedInputTokens).toBe(1)
    expect(capped.maxOutputTokens).toBe(131_072)

    const fallback = await estimator.estimate('model', {
      input: 'hello',
      max_output_tokens: 'not-an-integer'
    })
    expect(fallback.maxOutputTokens).toBe(4_096)
    expect(quote).toHaveBeenCalledTimes(3)
  })
})

describe('versioned model rates', () => {
  it('keeps rates Level-1-only and validates multiplier inputs', async () => {
    const database = await createCreditDatabase()
    try {
      const service = new ConcreteRateService(
        new CreditRepository(database.db, callback => database.inTransaction(callback)),
        new MutableClock(),
        new SequenceIdSource()
      )
      const level1 = {
        accountId: 'acct_admin',
        deviceSessionId: 'ds_admin',
        role: 'level1' as const,
        organizationId: null,
        accountVersion: 1,
        passwordVersion: 1
      }
      const level2 = { ...level1, role: 'level2' as const }
      expect(await service.rate('unconfigured-model')).toMatchObject({
        inputCreditPerToken: '0.001000',
        outputCreditPerToken: '0.002000',
        multiplier: '1.000000'
      })
      expect(await service.visibleRates(level2)).toEqual([])
      await expect(service.setModelRate(level2, {
        modelId: 'model',
        inputCreditPerToken: '1',
        outputCreditPerToken: '1',
        multiplier: '1'
      })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(service.setModelRate(level1, {
        modelId: '',
        inputCreditPerToken: '1',
        outputCreditPerToken: '1',
        multiplier: '1'
      })).rejects.toMatchObject({ code: 'model_rate_invalid' })
      await expect(service.setModelRate(level1, {
        modelId: 'model',
        inputCreditPerToken: '1',
        outputCreditPerToken: '1',
        multiplier: '0'
      })).rejects.toMatchObject({ code: 'model_rate_invalid' })
      await service.setModelRate(level1, {
        modelId: 'model',
        inputCreditPerToken: '0.01',
        outputCreditPerToken: '0.02',
        multiplier: '1.5'
      })
      expect(await service.visibleRates(level1)).toEqual([
        expect.objectContaining({
          modelId: 'model',
          inputCreditPerToken: '0.010000',
          outputCreditPerToken: '0.020000',
          multiplier: '1.500000'
        })
      ])
    } finally {
      await database.close()
    }
  })
})
