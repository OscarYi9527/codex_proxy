import { evaluateRiskPolicy } from '../../src/credits/turn-risk-service.js'

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
})

