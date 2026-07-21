import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import {
  ProviderRepository,
  type ProviderCredentialRecord
} from '../../src/db/repositories/provider-repository.js'
import {
  ProviderCredentialMaintenanceService
} from '../../src/security/provider-credential-maintenance.js'
import {
  ProviderCredentialVault
} from '../../src/security/provider-credential-vault.js'
import {
  StaticProviderCredentialKeyring
} from '../../src/security/provider-master-key.js'
import { MutableClock } from '../helpers/auth-fixture.js'

const providerId = 'provider_maintenance'
const oldKeyId = 'provider-key-old'
const newKeyId = 'provider-key-new'
const keys = new Map([
  [oldKeyId, new Uint8Array(32).fill(1)],
  [newKeyId, new Uint8Array(32).fill(2)]
])

function vault(activeKeyId = newKeyId): ProviderCredentialVault {
  return new ProviderCredentialVault(
    new StaticProviderCredentialKeyring(activeKeyId, keys)
  )
}

class FaultInjectingVault extends ProviderCredentialVault {
  override seal(
    secret: string,
    context: { providerId: string; credentialId: string }
  ): string {
    if (context.credentialId === 'credential_forced_failure') {
      throw new Error('forced provider credential migration failure')
    }
    return super.seal(secret, context)
  }
}

async function seedProvider(database: DatabaseHandle): Promise<void> {
  await database.db.insertInto('providers').values({
    id: providerId,
    kind: 'relay',
    display_name: 'Maintenance Relay',
    status: 'disabled',
    config_json: '{}',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    version: 1
  }).execute()
}

function repository(database: DatabaseHandle): ProviderRepository {
  return new ProviderRepository(
    database.db,
    callback => database.inTransaction(callback)
  )
}

function maintenance(
  database: DatabaseHandle,
  credentialVault = vault()
): ProviderCredentialMaintenanceService {
  return new ProviderCredentialMaintenanceService(
    repository(database),
    credentialVault,
    new MutableClock('2026-07-21T00:00:00.000Z')
  )
}

function credential(
  id: string,
  storageKind: ProviderCredentialRecord['storageKind'],
  secretPayload: string,
  updatedAt: string
): ProviderCredentialRecord {
  return {
    id,
    providerId,
    storageKind,
    secretPayload,
    createdAt: updatedAt,
    updatedAt
  }
}

describe('Provider credential migration and rewrap transactions', () => {
  let database: DatabaseHandle

  beforeEach(async () => {
    database = databaseHandle(createSqliteDatabase(':memory:'))
    await database.migrateToLatest()
    await seedProvider(database)
  })

  afterEach(async () => {
    await database.close()
  })

  it('dry-runs, atomically migrates plaintext and rewraps old keys', async () => {
    const legacySecret = 'legacy-provider-secret'
    const oldSecret = 'old-envelope-provider-secret'
    const oldVault = vault(oldKeyId)
    await repository(database).insertCredential(credential(
      'credential_plaintext',
      'plaintext-v1',
      legacySecret,
      '2026-07-17T00:02:00.000Z'
    ))
    await repository(database).insertCredential(credential(
      'credential_old_key',
      'envelope-v1',
      oldVault.seal(oldSecret, {
        providerId,
        credentialId: 'credential_old_key'
      }),
      '2026-07-17T00:01:00.000Z'
    ))

    const service = maintenance(database)
    const dryRun = await service.migratePlaintext({ dryRun: true })
    expect(dryRun).toMatchObject({
      operation: 'migrate',
      dryRun: true,
      totalCredentials: 2,
      changedCredentials: 1,
      plaintextCredentials: 0,
      envelopeCredentials: 2
    })
    expect((await repository(database).listCredentials())
      .find(item => item.id === 'credential_plaintext')?.storageKind)
      .toBe('plaintext-v1')
    expect(JSON.stringify(dryRun)).not.toContain(legacySecret)
    expect(JSON.stringify(dryRun)).not.toContain(oldSecret)

    const migrated = await service.migratePlaintext()
    expect(migrated.envelopeKeyCounts).toEqual({
      [newKeyId]: 1,
      [oldKeyId]: 1
    })
    const migratedRows = await repository(database).listCredentials()
    const migratedPlaintext = migratedRows
      .find(item => item.id === 'credential_plaintext') as ProviderCredentialRecord
    expect(migratedPlaintext.storageKind).toBe('envelope-v1')
    expect(migratedPlaintext.secretPayload).not.toContain(legacySecret)
    expect(vault().open(migratedPlaintext.secretPayload, {
      providerId,
      credentialId: migratedPlaintext.id
    })).toBe(legacySecret)

    const rewrapped = await service.rewrap()
    expect(rewrapped).toMatchObject({
      operation: 'rewrap',
      changedCredentials: 1,
      plaintextCredentials: 0,
      envelopeCredentials: 2,
      envelopeKeyCounts: { [newKeyId]: 2 },
      replacedKeyIds: [oldKeyId]
    })
    const verified = await service.verify()
    expect(verified).toMatchObject({
      operation: 'verify',
      verifiedCredentials: 2,
      envelopeKeyCounts: { [newKeyId]: 2 }
    })
  })

  it('rolls the whole plaintext migration back when any update fails', async () => {
    await repository(database).insertCredential(credential(
      'credential_updates_first',
      'plaintext-v1',
      'first-rollback-secret',
      '2026-07-17T00:02:00.000Z'
    ))
    await repository(database).insertCredential(credential(
      'credential_forced_failure',
      'plaintext-v1',
      'second-rollback-secret',
      '2026-07-17T00:01:00.000Z'
    ))
    const faultInjectingVault = new FaultInjectingVault(
      new StaticProviderCredentialKeyring(newKeyId, keys)
    )
    await expect(maintenance(database, faultInjectingVault).migratePlaintext())
      .rejects.toThrow(/forced provider credential migration failure/)
    const rows = await repository(database).listCredentials()
    expect(rows.map(item => item.storageKind)).toEqual([
      'plaintext-v1',
      'plaintext-v1'
    ])
    expect(rows.find(item => item.id === 'credential_updates_first')?.secretPayload)
      .toBe('first-rollback-secret')
  })

  it('fails verification on tampering without exposing plaintext', async () => {
    const secret = 'never-include-this-secret-in-errors'
    const payload = vault().seal(secret, {
      providerId,
      credentialId: 'credential_tampered'
    })
    const envelope = JSON.parse(payload) as Record<string, string>
    const tag = Buffer.from(envelope['tag'] as string, 'base64')
    tag[0] = (tag[0] as number) ^ 1
    await repository(database).insertCredential(credential(
      'credential_tampered',
      'envelope-v1',
      JSON.stringify({ ...envelope, tag: tag.toString('base64') }),
      '2026-07-17T00:00:00.000Z'
    ))

    let message = ''
    try {
      await maintenance(database).verify()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/verification failed/)
    expect(message).not.toContain(secret)
  })
})
