import { jest } from '@jest/globals'
import {
  evaluateRiskPolicy,
  TurnRiskService
} from '../../src/credits/turn-risk-service.js'
import { FixedClock } from '../../src/common/clock.js'
import type { ExemptTurnRecord } from '../../src/db/repositories/credit-repository.js'

describe('per-Turn and cumulative credit risk policy (T070/T076/T077)', () => {
  it('accepts the exact overdraft and cumulative boundaries', () => {
    expect(evaluateRiskPolicy({
      availableCredits: '10.000000',
      activeRiskCredits: '20.000000',
      turnRiskCredits: '15.000000',
      maxOverdraftPerTurn: '25.000000',
      maxCumulativeRisk: '35.000000'
    })).toEqual({
      projectedAvailableCredits: '-25.000000',
      projectedCumulativeRisk: '35.000000'
    })
  })

  it.each([
    ['per-turn overdraft', {
      availableCredits: '10.000000',
      activeRiskCredits: '20.000000',
      turnRiskCredits: '15.000001',
      maxOverdraftPerTurn: '25.000000',
      maxCumulativeRisk: '100.000000'
    }],
    ['cumulative risk', {
      availableCredits: '100.000000',
      activeRiskCredits: '20.000000',
      turnRiskCredits: '15.000001',
      maxOverdraftPerTurn: '100.000000',
      maxCumulativeRisk: '35.000000'
    }]
  ])('rejects a new Turn above the %s boundary', (_label, input) => {
    expect(() => evaluateRiskPolicy(input)).toThrow(
      expect.objectContaining({ code: 'credits_risk_limit', statusCode: 409 })
    )
  })

  it('records but does not reserve or limit a Level 1 administrator Turn', async () => {
    const estimate = jest.fn()
    let exemption: ExemptTurnRecord | null = null
    const repository = {
      inTransaction: jest.fn(async callback => callback(repository)),
      findTurnRisk: jest.fn(async () => null),
      findExemptTurn: jest.fn(async () => exemption),
      insertExemptTurn: jest.fn(async record => {
        exemption = record
      })
    }
    const service = new TurnRiskService(
      repository as never,
      {} as never,
      { estimate } as never,
      new FixedClock(new Date('2026-07-22T00:00:00.000Z'))
    )

    const request = {
      identity: {
        accountId: 'acct_level1',
        deviceSessionId: 'ds_level1',
        role: 'level1',
        organizationId: null,
        accountVersion: 1,
        passwordVersion: 1
      },
      turnId: 'turn_level1_unlimited',
      modelId: 'model',
      body: { input: 'hello' }
    } as const
    await expect(service.reserve(request)).resolves.toEqual({
      turnId: request.turnId,
      billingMode: 'exempt'
    })
    const firstSettlementId = exemption?.settlementId
    await expect(service.reserve(request)).resolves.toEqual({
      turnId: request.turnId,
      billingMode: 'exempt'
    })
    expect(estimate).not.toHaveBeenCalled()
    expect(repository.insertExemptTurn).toHaveBeenCalledTimes(1)
    expect(firstSettlementId).toMatch(/^usage_exempt_[a-f0-9]{32}$/)
    expect(exemption).toMatchObject({
      accountId: 'acct_level1',
      status: 'accepted',
      settlementId: firstSettlementId
    })
  })
})
