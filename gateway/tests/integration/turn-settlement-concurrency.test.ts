import { MutableClock } from '../helpers/auth-fixture.js'
import { createCreditDatabase, seedCreditIdentity } from '../helpers/credit-fixture.js'
import { SequenceIdSource } from '../../src/common/ids.js'
import { CreditRepository } from '../../src/db/repositories/credit-repository.js'
import { CreditService } from '../../src/credits/credit-service.js'
import { RateService } from '../../src/credits/rate-service.js'
import { RiskEstimator } from '../../src/credits/risk-estimator.js'
import { TurnRiskService } from '../../src/credits/turn-risk-service.js'
import { SettlementService } from '../../src/credits/settlement-service.js'

describe('idempotent concurrent Turn reservation and settlement (T071/T077-T079)', () => {
  it('reserves and settles 20 Turns exactly once', async () => {
    const database = await createCreditDatabase()
    try {
      const identity = await seedCreditIdentity(database)
      const now = '2026-07-18T00:00:00.000Z'
      await database.db.insertInto('providers').values({
        id: 'provider_credit_test',
        kind: 'relay',
        display_name: 'Credit test provider',
        status: 'active',
        config_json: '{}',
        created_at: now,
        updated_at: now,
        version: 1
      }).execute()
      await database.db.insertInto('model_routes').values({
        id: 'route_credit_test',
        public_model_id: 'credit-test-model',
        provider_id: 'provider_credit_test',
        upstream_model_id: 'credit-test-model',
        priority: 1,
        enabled: 1,
        policy_json: '{}',
        created_at: now,
        updated_at: now,
        version: 1
      }).execute()
      const clock = new MutableClock(now)
      const ids = new SequenceIdSource()
      const repository = new CreditRepository(
        database.db,
        callback => database.inTransaction(callback)
      )
      const credits = new CreditService(repository, clock, ids)
      const rates = new RateService(repository, clock, ids)
      const estimator = new RiskEstimator(rates)
      const risks = new TurnRiskService(repository, credits, estimator, clock)
      const settlement = new SettlementService(repository, rates, clock, ids)
      const actor = {
        accountId: identity.accountId,
        deviceSessionId: identity.deviceSessionId,
        role: 'level1' as const,
        organizationId: null,
        accountVersion: 1,
        passwordVersion: 1
      }
      await credits.setMonthlyCredits(actor, identity.organizationId, '1000')
      await credits.setUserAllocation(actor, identity.accountId, '1000')
      await rates.setModelRate(actor, {
        modelId: 'credit-test-model',
        inputCreditPerToken: '0.001',
        outputCreditPerToken: '0.002',
        multiplier: '1'
      })
      await credits.setRiskPolicy(actor, identity.organizationId, {
        maxOverdraftPerTurn: '1000',
        maxCumulativeRisk: '1000'
      })
      const accessIdentity = {
        accountId: identity.accountId,
        deviceSessionId: identity.deviceSessionId,
        role: 'user' as const,
        organizationId: identity.organizationId,
        accountVersion: 1,
        passwordVersion: 1
      }
      const turnIds = Array.from({ length: 20 }, (_, index) =>
        `turn_concurrency_${String(index).padStart(2, '0')}`
      )
      await Promise.all(turnIds.flatMap(turnId => [
        risks.reserve({
          identity: accessIdentity,
          turnId,
          modelId: 'credit-test-model',
          body: { input: 'hello', max_output_tokens: 100 }
        }),
        risks.reserve({
          identity: accessIdentity,
          turnId,
          modelId: 'credit-test-model',
          body: { input: 'hello', max_output_tokens: 100 }
        })
      ]))
      await Promise.all(turnIds.flatMap(turnId => [
        settlement.settle(turnId, {
          providerId: 'provider_credit_test',
          usage: { inputTokens: 10, outputTokens: 20 }
        }),
        settlement.settle(turnId, {
          providerId: 'provider_credit_test',
          usage: { inputTokens: 10, outputTokens: 20 }
        })
      ]))

      const risksCount = await database.db
        .selectFrom('turn_risks')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow()
      const usageCount = await database.db
        .selectFrom('usage_records')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow()
      const summary = await credits.accountCredits(identity.accountId)
      expect(Number(risksCount.count)).toBe(20)
      expect(Number(usageCount.count)).toBe(20)
      expect(summary.settled).toBe('1.000000')
      expect(summary.available).toBe('999.000000')
    } finally {
      await database.close()
    }
  })
})

