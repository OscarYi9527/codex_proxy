import type { SafeLogger } from '../common/logging.js'
import type { SettlementService } from '../credits/settlement-service.js'
import { ProviderWorkerClient } from './provider-worker-client.js'

const DEFAULT_INTERVAL_MS = 15_000

export class ProviderWorkerSettlementReconciler {
  #timer: ReturnType<typeof setInterval> | null = null
  #active: Promise<void> | null = null

  constructor(
    private readonly client: ProviderWorkerClient,
    private readonly settlements: SettlementService,
    private readonly logger: SafeLogger,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly recoverRuntime?: () => Promise<boolean>
  ) {}

  start(): void {
    if (this.#timer) return
    void this.reconcileOnce()
    this.#timer = setInterval(() => {
      void this.reconcileOnce()
    }, this.intervalMs)
    this.#timer.unref()
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#active
  }

  async reconcileOnce(): Promise<void> {
    if (this.#active) return this.#active
    this.#active = this.#run().finally(() => {
      this.#active = null
    })
    return this.#active
  }

  async #run(): Promise<void> {
    if (this.recoverRuntime) {
      try {
        if (await this.recoverRuntime()) {
          this.logger.info('provider_worker_runtime_recovered')
        }
      } catch (error) {
        this.logger.warn('provider_worker_runtime_recovery_failed', { error })
      }
    }
    let receipts
    try {
      receipts = await this.client.listPendingUsage(100)
    } catch (error) {
      this.logger.warn('provider_worker_outbox_fetch_failed', { error })
      return
    }
    const acknowledgements: Array<{
      outboxId: string
      turnId: string
      settlementId: string
      settledAt: string
    }> = []
    for (const receipt of receipts) {
      try {
        const usage = await this.settlements.settle(receipt.turnId, {
          providerId: receipt.providerId,
          usage: {
            inputTokens: receipt.inputTokens,
            outputTokens: receipt.outputTokens
          }
        })
        if (!usage) {
          this.logger.warn('provider_worker_outbox_turn_not_settleable', {
            turnId: receipt.turnId,
            outboxId: receipt.outboxId
          })
          continue
        }
        acknowledgements.push({
          outboxId: receipt.outboxId,
          turnId: receipt.turnId,
          settlementId: usage.id,
          settledAt: usage.completedAt
        })
      } catch (error) {
        this.logger.warn('provider_worker_outbox_settlement_failed', {
          turnId: receipt.turnId,
          outboxId: receipt.outboxId,
          error
        })
      }
    }
    if (!acknowledgements.length) return
    try {
      await this.client.acknowledgeUsage(acknowledgements)
      this.logger.info('provider_worker_outbox_reconciled', {
        count: acknowledgements.length
      })
    } catch (error) {
      // SettlementService is idempotent by Turn ID. A later poll safely
      // reuses the same usage record and retries only the signed acknowledgement.
      this.logger.warn('provider_worker_outbox_ack_failed', {
        count: acknowledgements.length,
        error
      })
    }
  }
}
