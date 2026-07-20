import type { Clock } from '../common/clock.js'
import type { IdSource } from '../common/ids.js'
import { ProviderRepository } from '../db/repositories/provider-repository.js'

export interface CredentialMigrationSummary {
  readonly examined: number
  readonly changed: number
  readonly skipped: number
  readonly remainingPlaintext: number
  readonly envelopeCredentials: number
}

export class CredentialMigrationService {
  constructor(
    private readonly repository: ProviderRepository,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async migratePlaintext(actorAccountId: string): Promise<CredentialMigrationSummary> {
    const records = (await this.repository.listStoredCredentials())
      .filter(record => record.storageKind === 'plaintext-v1')
    let changed = 0
    for (const record of records) {
      const outcome = await this.repository.inTransaction(async repository => {
        const result = await repository.migratePlaintextCredential(
          record.providerId,
          record.id,
          this.clock.now().toISOString()
        )
        if (result === 'migrated') {
          await repository.insertAuditEvent({
            id: this.ids.opaque('audit'),
            actorAccountId,
            organizationId: null,
            action: 'provider.credential.migrate',
            targetType: 'provider_credential',
            targetId: record.id,
            outcome: 'allowed',
            safeMetadata: {
              from: 'plaintext-v1',
              to: 'envelope-v1'
            },
            createdAt: this.clock.now().toISOString()
          })
        }
        return result
      })
      if (outcome === 'migrated') changed += 1
    }
    return {
      examined: records.length,
      changed,
      skipped: records.length - changed,
      remainingPlaintext: await this.repository.countPlaintextCredentials(),
      envelopeCredentials: await this.repository.countEnvelopeCredentials()
    }
  }

  async rewrapToCurrentKey(actorAccountId: string): Promise<CredentialMigrationSummary> {
    const records = (await this.repository.listStoredCredentials())
      .filter(record => record.storageKind === 'envelope-v1')
    let changed = 0
    for (const record of records) {
      const outcome = await this.repository.inTransaction(async repository => {
        const result = await repository.rewrapCredential(
          record.providerId,
          record.id,
          this.clock.now().toISOString()
        )
        if (result === 'rewrapped') {
          const current = (await repository.listStoredCredentials(record.providerId))
            .find(item => item.id === record.id)
          await repository.insertAuditEvent({
            id: this.ids.opaque('audit'),
            actorAccountId,
            organizationId: null,
            action: 'provider.credential.rewrap',
            targetType: 'provider_credential',
            targetId: record.id,
            outcome: 'allowed',
            safeMetadata: {
              fromKeyVersion: record.keyVersion,
              toKeyVersion: current?.keyVersion || null
            },
            createdAt: this.clock.now().toISOString()
          })
        }
        return result
      })
      if (outcome === 'rewrapped') changed += 1
    }
    return {
      examined: records.length,
      changed,
      skipped: records.length - changed,
      remainingPlaintext: await this.repository.countPlaintextCredentials(),
      envelopeCredentials: await this.repository.countEnvelopeCredentials()
    }
  }

  async verifyAll(): Promise<{
    readonly verified: number
    readonly plaintext: number
  }> {
    const stored = await this.repository.listStoredCredentials()
    const envelope = stored.filter(record => record.storageKind === 'envelope-v1')
    // listCredentials decrypts and authenticates every envelope before returning.
    const revealed = await this.repository.listCredentials()
    if (revealed.length !== stored.length) {
      throw new Error('Credential verification count mismatch')
    }
    return {
      verified: envelope.length,
      plaintext: stored.length - envelope.length
    }
  }
}
