import { FixedClock } from '../../src/common/clock.js'
import { CryptoIdSource, SequenceIdSource } from '../../src/common/ids.js'
import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { ProviderRepository } from '../../src/db/repositories/provider-repository.js'
import { CredentialMigrationService } from '../../src/providers/credential-migration-service.js'
import { StaticCredentialKeyProvider } from '../../src/security/credential-keys.js'
import { EnvelopeCredentialProtector } from '../../src/security/envelope-credential-protector.js'
import type { CredentialProtector } from '../../src/security/envelope-credential-protector.js'

describe('Provider credential envelope migration and rotation (T136)', () => {
  let database: DatabaseHandle
  const now = '2026-07-20T00:00:00.000Z'

  beforeEach(async () => {
    database = databaseHandle(createSqliteDatabase(':memory:'))
    await database.migrateToLatest()
    await database.db.insertInto('accounts').values({
      id: 'account_envelope_admin',
      login_name: 'envelope-admin',
      email: 'envelope@example.test',
      role: 'level1',
      organization_id: null,
      status: 'active',
      expires_at: null,
      must_change_password: 0,
      must_provide_email: 0,
      created_at: now,
      updated_at: now,
      disabled_at: null,
      disabled_by: null,
      version: 1
    }).execute()
    await database.db.insertInto('providers').values({
      id: 'provider_envelope',
      kind: 'openai',
      display_name: 'Envelope Provider',
      status: 'active',
      config_json: '{}',
      created_at: now,
      updated_at: now,
      version: 1
    }).execute()
    await database.db.insertInto('provider_credentials').values({
      id: 'cred_envelope',
      provider_id: 'provider_envelope',
      storage_kind: 'plaintext-v1',
      secret_payload: 'sk-plaintext-migration-secret',
      key_version: null,
      credential_version: 1,
      created_at: now,
      updated_at: now
    }).execute()
  })

  afterEach(async () => {
    await database.close()
  })

  it('migrates idempotently, updates encrypted writes and rewraps after key rotation', async () => {
    const keys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-local-v1',
      keys: {
        'kms-local-v1': new Uint8Array(32).fill(31),
        'kms-local-v2': new Uint8Array(32).fill(37)
      }
    })
    const protector = new EnvelopeCredentialProtector(keys)
    const repository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      protector
    )
    const migration = new CredentialMigrationService(
      repository,
      new FixedClock(now),
      new SequenceIdSource()
    )

    await expect(repository.listCredentials()).resolves.toEqual([
      expect.objectContaining({
        id: 'cred_envelope',
        storageKind: 'plaintext-v1',
        secretPayload: 'sk-plaintext-migration-secret'
      })
    ])
    await expect(migration.migratePlaintext('account_envelope_admin'))
      .resolves.toMatchObject({
        examined: 1,
        changed: 1,
        remainingPlaintext: 0,
        envelopeCredentials: 1
      })
    const migrated = await database.db.selectFrom('provider_credentials')
      .selectAll()
      .where('id', '=', 'cred_envelope')
      .executeTakeFirstOrThrow()
    expect(migrated.storage_kind).toBe('envelope-v1')
    expect(migrated.key_version).toBe('kms-local-v1')
    expect(migrated.credential_version).toBe(1)
    expect(migrated.secret_payload).not.toContain('sk-plaintext-migration-secret')
    await expect(migration.migratePlaintext('account_envelope_admin'))
      .resolves.toMatchObject({ examined: 0, changed: 0 })
    await expect(migration.verifyAll()).resolves.toEqual({
      verified: 1,
      plaintext: 0
    })

    await expect(repository.updateCredential(
      'provider_envelope',
      'cred_envelope',
      {
        storageKind: 'plaintext-v1',
        secretPayload: 'sk-replaced-secret',
        updatedAt: now
      }
    )).resolves.toBe(true)
    const replaced = await database.db.selectFrom('provider_credentials')
      .selectAll()
      .where('id', '=', 'cred_envelope')
      .executeTakeFirstOrThrow()
    expect(replaced.credential_version).toBe(2)
    expect(replaced.secret_payload).not.toContain('sk-replaced-secret')
    await expect(repository.listCredentials()).resolves.toEqual([
      expect.objectContaining({
        storageKind: 'envelope-v1',
        keyVersion: 'kms-local-v1',
        credentialVersion: 2,
        secretPayload: 'sk-replaced-secret'
      })
    ])

    keys.setCurrentVersion('kms-local-v2')
    await expect(migration.rewrapToCurrentKey('account_envelope_admin'))
      .resolves.toMatchObject({ examined: 1, changed: 1 })
    const rotated = await database.db.selectFrom('provider_credentials')
      .selectAll()
      .where('id', '=', 'cred_envelope')
      .executeTakeFirstOrThrow()
    expect(rotated.key_version).toBe('kms-local-v2')
    expect(rotated.credential_version).toBe(2)
    await expect(repository.listCredentials()).resolves.toEqual([
      expect.objectContaining({ secretPayload: 'sk-replaced-secret' })
    ])

    const audits = await database.db.selectFrom('admin_audit_events')
      .select(['action', 'target_id'])
      .where('target_id', '=', 'cred_envelope')
      .orderBy('created_at', 'asc')
      .execute()
    expect(audits.map(value => value.action)).toEqual([
      'provider.credential.migrate',
      'provider.credential.rewrap'
    ])
  })

  it('fails closed when ciphertext or the master key is wrong', async () => {
    const protector = new EnvelopeCredentialProtector(
      new StaticCredentialKeyProvider({
        currentVersion: 'kms-local-v1',
        keys: { 'kms-local-v1': new Uint8Array(32).fill(41) }
      })
    )
    const repository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      protector
    )
    const migration = new CredentialMigrationService(
      repository,
      new FixedClock(now),
      new SequenceIdSource()
    )
    await migration.migratePlaintext('account_envelope_admin')
    const row = await database.db.selectFrom('provider_credentials')
      .select('secret_payload')
      .where('id', '=', 'cred_envelope')
      .executeTakeFirstOrThrow()
    const envelope = JSON.parse(row.secret_payload)
    envelope.payload.tag = Buffer.alloc(16, 7).toString('base64')
    await database.db.updateTable('provider_credentials')
      .set({ secret_payload: JSON.stringify(envelope) })
      .where('id', '=', 'cred_envelope')
      .execute()
    await expect(repository.listCredentials()).rejects.toThrow(
      /authentication/
    )

    const wrongRepository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      new EnvelopeCredentialProtector(new StaticCredentialKeyProvider({
        currentVersion: 'kms-local-v1',
        keys: { 'kms-local-v1': new Uint8Array(32).fill(43) }
      }))
    )
    await expect(wrongRepository.listCredentials()).rejects.toThrow()
  })

  it('resumes an interrupted migration without losing format identity', async () => {
    await database.db.insertInto('provider_credentials').values({
      id: 'cred_envelope_second',
      provider_id: 'provider_envelope',
      storage_kind: 'plaintext-v1',
      secret_payload: 'sk-second-plaintext-secret',
      key_version: null,
      credential_version: 1,
      created_at: now,
      updated_at: now
    }).execute()
    const keys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-local-v1',
      keys: { 'kms-local-v1': new Uint8Array(32).fill(61) }
    })
    const delegate = new EnvelopeCredentialProtector(keys)
    let protectCalls = 0
    const interrupted = {
      currentKeyVersion: () => delegate.currentKeyVersion(),
      reveal: (...args) => delegate.reveal(...args),
      rewrap: (...args) => delegate.rewrap(...args),
      async protect(...args) {
        protectCalls += 1
        if (protectCalls === 2) throw new Error('simulated migration interruption')
        return delegate.protect(...args)
      }
    } satisfies CredentialProtector
    const interruptedRepository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      interrupted
    )
    await expect(new CredentialMigrationService(
      interruptedRepository,
      new FixedClock(now),
      new SequenceIdSource()
    ).migratePlaintext('account_envelope_admin')).rejects.toThrow(
      /simulated migration interruption/
    )
    const partial = await database.db.selectFrom('provider_credentials')
      .select(['id', 'storage_kind'])
      .orderBy('id', 'asc')
      .execute()
    expect(partial.map(value => value.storage_kind).sort()).toEqual([
      'envelope-v1',
      'plaintext-v1'
    ])

    const resumedRepository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      delegate
    )
    await expect(new CredentialMigrationService(
      resumedRepository,
      new FixedClock(now),
      new CryptoIdSource()
    ).migratePlaintext('account_envelope_admin')).resolves.toMatchObject({
      examined: 1,
      changed: 1,
      remainingPlaintext: 0,
      envelopeCredentials: 2
    })
    await expect(resumedRepository.listCredentials()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cred_envelope',
          secretPayload: 'sk-plaintext-migration-secret'
        }),
        expect.objectContaining({
          id: 'cred_envelope_second',
          secretPayload: 'sk-second-plaintext-secret'
        })
      ])
    )
  })
})
