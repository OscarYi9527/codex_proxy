import { jest } from '@jest/globals'
import { FixedClock } from '../../src/common/clock.js'
import { SafeLogger, type LogRecord } from '../../src/common/logging.js'
import type { SettlementService } from '../../src/credits/settlement-service.js'
import type { UsageRecord } from '../../src/db/repositories/credit-repository.js'
import type { ProviderWorkerClient } from '../../src/provider-worker/provider-worker-client.js'
import { ProviderWorkerSettlementReconciler } from '../../src/provider-worker/settlement-reconciler.js'
import type { ProviderUsageReceipt } from '../../src/provider-worker/protocol.js'

describe('ProviderWorkerSettlementReconciler', () => {
  it('settles verified outbox usage and sends an idempotent Gateway acknowledgement', async () => {
    const receipt: ProviderUsageReceipt = {
      schemaVersion: 1,
      outboxId: 'outbox_reconcile',
      executionId: 'exec_reconcile',
      turnId: 'turn_reconcile',
      workerId: 'worker-local',
      region: 'local-development',
      providerId: 'provider-worker-mock',
      inputTokens: 13,
      outputTokens: 5,
      completedAt: '2026-07-20T00:00:00.000Z',
      signature: `v1=${'a'.repeat(64)}`
    }
    const acknowledgements: unknown[] = []
    const client = {
      listPendingUsage: jest.fn(async () => [receipt]),
      acknowledgeUsage: jest.fn(async value => {
        acknowledgements.push(value)
      })
    } as unknown as ProviderWorkerClient
    const usage: UsageRecord = {
      id: 'usage_reconcile',
      turnId: receipt.turnId,
      accountId: 'account_reconcile',
      organizationId: 'org_reconcile',
      periodId: 'period_reconcile',
      modelId: 'gpt-worker-mock',
      providerId: receipt.providerId,
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      usageSource: 'upstream',
      inputCredits: '0.010000',
      outputCredits: '0.010000',
      totalCredits: '0.020000',
      startedAt: '2026-07-20T00:00:00.000Z',
      completedAt: '2026-07-20T00:00:01.000Z',
      routeErrorCode: null
    }
    const settlements = {
      settle: jest.fn(async () => usage)
    } as unknown as SettlementService
    const logs: LogRecord[] = []
    const reconciler = new ProviderWorkerSettlementReconciler(
      client,
      settlements,
      new SafeLogger({
        clock: new FixedClock(new Date('2026-07-20T00:00:02.000Z')),
        sink: record => logs.push(record)
      })
    )

    await reconciler.reconcileOnce()

    expect(settlements.settle).toHaveBeenCalledWith(receipt.turnId, {
      providerId: receipt.providerId,
      usage: {
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens
      }
    })
    expect(acknowledgements).toEqual([[
      {
        outboxId: receipt.outboxId,
        turnId: receipt.turnId,
        settlementId: usage.id,
        settledAt: usage.completedAt
      }
    ]])
    expect(logs.at(-1)).toMatchObject({
      level: 'info',
      event: 'provider_worker_outbox_reconciled',
      fields: { count: 1 }
    })
  })

  it('leaves the outbox pending when the Gateway cannot map a Turn risk', async () => {
    const client = {
      listPendingUsage: jest.fn(async () => [{
        schemaVersion: 1,
        outboxId: 'outbox_missing_risk',
        executionId: 'exec_missing_risk',
        turnId: 'turn_missing_risk',
        workerId: 'worker-local',
        region: 'local-development',
        providerId: 'provider-worker-mock',
        inputTokens: 1,
        outputTokens: 1,
        completedAt: '2026-07-20T00:00:00.000Z',
        signature: `v1=${'b'.repeat(64)}`
      }]),
      acknowledgeUsage: jest.fn()
    } as unknown as ProviderWorkerClient
    const settlements = {
      settle: jest.fn(async () => null)
    } as unknown as SettlementService
    const logs: LogRecord[] = []
    const reconciler = new ProviderWorkerSettlementReconciler(
      client,
      settlements,
      new SafeLogger({ sink: record => logs.push(record) })
    )

    await reconciler.reconcileOnce()

    expect(client.acknowledgeUsage).not.toHaveBeenCalled()
    expect(logs.some(record =>
      record.event === 'provider_worker_outbox_turn_not_settleable'
    )).toBe(true)
  })
})
