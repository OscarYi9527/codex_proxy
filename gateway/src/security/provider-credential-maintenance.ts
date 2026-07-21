import type { Clock } from '../common/clock.js'
import {
  ProviderRepository,
  type ProviderCredentialRecord
} from '../db/repositories/provider-repository.js'
import { ProviderCredentialVault } from './provider-credential-vault.js'
import { redactText } from '../common/redaction.js'

export type ProviderCredentialMaintenanceOperation = 'verify' | 'migrate' | 'rewrap'

export interface ProviderCredentialMaintenanceReport {
  readonly operation: ProviderCredentialMaintenanceOperation
  readonly dryRun: boolean
  readonly totalCredentials: number
  readonly verifiedCredentials: number
  readonly changedCredentials: number
  readonly plaintextCredentials: number
  readonly envelopeCredentials: number
  readonly activeKeyId: string
  readonly envelopeKeyCounts: Readonly<Record<string, number>>
  readonly replacedKeyIds: readonly string[]
}

interface Inspection {
  readonly plaintextCredentials: number
  readonly envelopeCredentials: number
  readonly envelopeKeyCounts: Readonly<Record<string, number>>
}

function context(record: ProviderCredentialRecord) {
  return {
    providerId: record.providerId,
    credentialId: record.id
  }
}

function safeFailure(record: ProviderCredentialRecord, error: unknown): Error {
  const reason = error instanceof Error ? redactText(error.message) : 'unknown failure'
  return new Error(
    `Provider credential verification failed for ${record.id}: ${reason}`
  )
}

export class ProviderCredentialMaintenanceService {
  constructor(
    private readonly repository: ProviderRepository,
    private readonly vault: ProviderCredentialVault,
    private readonly clock: Clock
  ) {}

  async verify(): Promise<ProviderCredentialMaintenanceReport> {
    const credentials = await this.repository.listCredentials()
    const inspection = this.inspect(credentials)
    return this.report('verify', false, credentials, 0, inspection, [])
  }

  async migratePlaintext(options: {
    dryRun?: boolean
  } = {}): Promise<ProviderCredentialMaintenanceReport> {
    const dryRun = options.dryRun === true
    return this.repository.inTransaction(async repository => {
      const credentials = await repository.listCredentials()
      const before = this.inspect(credentials)
      const now = this.clock.now().toISOString()
      let changed = 0
      for (const credential of credentials) {
        if (credential.storageKind !== 'plaintext-v1') continue
        const encrypted = this.vault.seal(credential.secretPayload, context(credential))
        let verified: string
        try {
          verified = this.vault.open(encrypted, context(credential))
        } catch (error) {
          throw safeFailure(credential, error)
        }
        if (verified !== credential.secretPayload) {
          throw safeFailure(credential, new Error('seal/open verification mismatch'))
        }
        changed += 1
        if (dryRun) continue
        const updated = await repository.updateCredentialPayload({
          providerId: credential.providerId,
          credentialId: credential.id,
          expectedStorageKind: credential.storageKind,
          expectedSecretPayload: credential.secretPayload,
          storageKind: 'envelope-v1',
          secretPayload: encrypted,
          updatedAt: now
        })
        if (!updated) {
          throw new Error(
            `Provider credential ${credential.id} changed concurrently; migration rolled back`
          )
        }
      }
      const after = dryRun
        ? {
            plaintextCredentials: before.plaintextCredentials - changed,
            envelopeCredentials: before.envelopeCredentials + changed,
            envelopeKeyCounts: {
              ...before.envelopeKeyCounts,
              [this.vault.activeKeyId()]:
                (before.envelopeKeyCounts[this.vault.activeKeyId()] || 0) + changed
            }
          }
        : this.inspect(await repository.listCredentials())
      return this.report('migrate', dryRun, credentials, changed, after, [])
    })
  }

  async rewrap(options: {
    dryRun?: boolean
  } = {}): Promise<ProviderCredentialMaintenanceReport> {
    const dryRun = options.dryRun === true
    return this.repository.inTransaction(async repository => {
      const credentials = await repository.listCredentials()
      const before = this.inspect(credentials)
      if (before.plaintextCredentials > 0) {
        throw new Error(
          'Provider plaintext credentials remain; migrate them before rewrapping'
        )
      }
      const now = this.clock.now().toISOString()
      const replacedKeyIds = new Set<string>()
      let changed = 0
      for (const credential of credentials) {
        let currentKeyId: string
        try {
          currentKeyId = this.vault.envelopeKeyId(credential.secretPayload)
          // Verify every record, including those already using the active key.
          this.vault.open(credential.secretPayload, context(credential))
        } catch (error) {
          throw safeFailure(credential, error)
        }
        if (currentKeyId === this.vault.activeKeyId()) continue
        replacedKeyIds.add(currentKeyId)
        const encrypted = this.vault.rewrap(credential.secretPayload, context(credential))
        try {
          this.vault.open(encrypted, context(credential))
        } catch (error) {
          throw safeFailure(credential, error)
        }
        changed += 1
        if (dryRun) continue
        const updated = await repository.updateCredentialPayload({
          providerId: credential.providerId,
          credentialId: credential.id,
          expectedStorageKind: 'envelope-v1',
          expectedSecretPayload: credential.secretPayload,
          storageKind: 'envelope-v1',
          secretPayload: encrypted,
          updatedAt: now
        })
        if (!updated) {
          throw new Error(
            `Provider credential ${credential.id} changed concurrently; rewrap rolled back`
          )
        }
      }
      const after = dryRun
        ? {
            plaintextCredentials: 0,
            envelopeCredentials: before.envelopeCredentials,
            envelopeKeyCounts: before.envelopeCredentials === 0
              ? {}
              : { [this.vault.activeKeyId()]: before.envelopeCredentials }
          }
        : this.inspect(await repository.listCredentials())
      return this.report(
        'rewrap',
        dryRun,
        credentials,
        changed,
        after,
        [...replacedKeyIds].sort()
      )
    })
  }

  private inspect(credentials: readonly ProviderCredentialRecord[]): Inspection {
    let plaintextCredentials = 0
    let envelopeCredentials = 0
    const keyCounts: Record<string, number> = {}
    for (const credential of credentials) {
      if (credential.storageKind === 'plaintext-v1') {
        if (!credential.secretPayload) {
          throw safeFailure(credential, new Error('plaintext payload is empty'))
        }
        plaintextCredentials += 1
        continue
      }
      try {
        this.vault.open(credential.secretPayload, context(credential))
        const keyId = this.vault.envelopeKeyId(credential.secretPayload)
        keyCounts[keyId] = (keyCounts[keyId] || 0) + 1
      } catch (error) {
        throw safeFailure(credential, error)
      }
      envelopeCredentials += 1
    }
    return {
      plaintextCredentials,
      envelopeCredentials,
      envelopeKeyCounts: Object.fromEntries(
        Object.entries(keyCounts).sort(([left], [right]) => left.localeCompare(right))
      )
    }
  }

  private report(
    operation: ProviderCredentialMaintenanceOperation,
    dryRun: boolean,
    credentials: readonly ProviderCredentialRecord[],
    changedCredentials: number,
    inspection: Inspection,
    replacedKeyIds: readonly string[]
  ): ProviderCredentialMaintenanceReport {
    return {
      operation,
      dryRun,
      totalCredentials: credentials.length,
      verifiedCredentials: credentials.length,
      changedCredentials,
      plaintextCredentials: inspection.plaintextCredentials,
      envelopeCredentials: inspection.envelopeCredentials,
      activeKeyId: this.vault.activeKeyId(),
      envelopeKeyCounts: inspection.envelopeKeyCounts,
      replacedKeyIds
    }
  }
}
