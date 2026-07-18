import { MutableClock } from '../helpers/auth-fixture.js'
import { createCreditDatabase, seedCreditIdentity } from '../helpers/credit-fixture.js'
import { SequenceIdSource } from '../../src/common/ids.js'
import { CreditRepository } from '../../src/db/repositories/credit-repository.js'
import { CreditService } from '../../src/credits/credit-service.js'

describe('monthly credit periods (T069/T073/T074)', () => {
  it('starts a new organization month without carrying settled usage forward', async () => {
    const database = await createCreditDatabase()
    try {
      const identity = await seedCreditIdentity(database)
      const clock = new MutableClock('2026-07-18T00:00:00.000Z')
      const repository = new CreditRepository(
        database.db,
        callback => database.inTransaction(callback)
      )
      const service = new CreditService(repository, clock, new SequenceIdSource())
      const actor = {
        accountId: identity.accountId,
        deviceSessionId: identity.deviceSessionId,
        role: 'level1' as const,
        organizationId: null,
        accountVersion: 1,
        passwordVersion: 1
      }

      const july = await service.setMonthlyCredits(actor, identity.organizationId, '1000')
      await service.setUserAllocation(actor, identity.accountId, '600')
      await repository.addSettledCredits(
        july.id,
        identity.accountId,
        '125.500000'
      )

      clock.advance(20 * 24 * 60 * 60 * 1000)
      const august = await service.ensureCurrentPeriod(identity.organizationId)
      const account = await service.accountCredits(identity.accountId)

      expect(august.id).not.toBe(july.id)
      expect(august.allocatedCredits).toBe('1000.000000')
      expect(august.settledCredits).toBe('0.000000')
      expect(account).toMatchObject({
        allocated: '600.000000',
        settled: '0.000000',
        available: '600.000000'
      })
      const previous = await repository.findPeriodById(july.id)
      expect(previous?.closedAt).toBe(clock.now().toISOString())
    } finally {
      await database.close()
    }
  })

  it('uses organization billing timezone month boundaries', async () => {
    const database = await createCreditDatabase()
    try {
      const { organizationId } = await seedCreditIdentity(database)
      const clock = new MutableClock('2026-07-18T00:00:00.000Z')
      const service = new CreditService(
        new CreditRepository(database.db, callback => database.inTransaction(callback)),
        clock,
        new SequenceIdSource()
      )
      const period = await service.ensureCurrentPeriod(organizationId)
      expect(period.periodStart).toBe('2026-06-30T16:00:00.000Z')
      expect(period.periodEnd).toBe('2026-07-31T16:00:00.000Z')
    } finally {
      await database.close()
    }
  })

  it('enforces organization pools and Level-2 allocation scope', async () => {
    const database = await createCreditDatabase()
    try {
      const own = await seedCreditIdentity(database)
      const other = await seedCreditIdentity(database, {
        organizationId: 'org_credit_other',
        accountId: 'acct_credit_other',
        deviceSessionId: 'ds_credit_other'
      })
      const clock = new MutableClock('2026-07-18T00:00:00.000Z')
      const service = new CreditService(
        new CreditRepository(database.db, callback => database.inTransaction(callback)),
        clock,
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
      const level2 = {
        ...level1,
        role: 'level2' as const,
        organizationId: own.organizationId
      }
      await service.setMonthlyCredits(level1, own.organizationId, '100')
      await service.setUserAllocation(level1, own.accountId, '80')
      await expect(
        service.setMonthlyCredits(level1, own.organizationId, '79')
      ).rejects.toMatchObject({ code: 'credit_allocation_exceeds_pool' })
      await service.setUserAllocation(level2, own.accountId, '70')
      await expect(
        service.setUserAllocation(level2, other.accountId, '1')
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        service.setMonthlyCredits(level2, own.organizationId, '100')
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        service.setRiskPolicy(level2, own.organizationId, {
          maxOverdraftPerTurn: '10',
          maxCumulativeRisk: '20'
        })
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        service.setRiskPolicy(level1, own.organizationId, {
          maxOverdraftPerTurn: '0',
          maxCumulativeRisk: '20'
        })
      ).rejects.toMatchObject({ code: 'credit_value_invalid' })
      await expect(
        service.setUserAllocation(level1, own.accountId, 'invalid')
      ).rejects.toMatchObject({ code: 'credit_value_invalid' })
      expect(await service.accountCredits('acct_missing')).toEqual({
        periodId: null,
        periodStart: null,
        periodEnd: null,
        allocated: '0.000000',
        settled: '0.000000',
        available: '0.000000'
      })
      await expect(
        service.organizationView({
          ...level2,
          role: 'user'
        }, own.organizationId)
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        service.setUserAllocation(level1, 'acct_missing', '1')
      ).rejects.toMatchObject({ code: 'account_not_found' })
      await expect(
        service.setRiskPolicy(level1, 'org_missing', {
          maxOverdraftPerTurn: '10',
          maxCumulativeRisk: '20'
        })
      ).rejects.toMatchObject({ code: 'organization_not_found' })
      await database.db.updateTable('accounts')
        .set({ role: 'level2' })
        .where('id', '=', own.accountId)
        .execute()
      await expect(
        service.setUserAllocation(level2, own.accountId, '1')
      ).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await database.close()
    }
  })
})
