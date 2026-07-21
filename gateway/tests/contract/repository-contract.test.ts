import { newDb } from 'pg-mem'
import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createPostgresDatabase } from '../../src/db/dialects/postgres.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { up as applyInitialMigration } from '../../src/db/migrations/001_initial.js'
import {
  up as applyProviderCredentialPayloadMigration
} from '../../src/db/migrations/002_provider_credential_payload_text.js'
import { GatewayMetaRepository } from '../../src/db/repositories/gateway-meta-repository.js'
import { ProviderRepository } from '../../src/db/repositories/provider-repository.js'

type Factory = () => DatabaseHandle

const factories: Array<[string, Factory]> = [
  ['sqlite', () => databaseHandle(createSqliteDatabase(':memory:'))],
  ['postgres', () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true })
    const adapter = memory.adapters.createPg()
    const pool = new adapter.Pool()
    return databaseHandle(createPostgresDatabase({ pool }))
  }]
]

describe.each(factories)('%s repository contract', (_dialect, factory) => {
  let handle: DatabaseHandle

  beforeEach(async () => {
    handle = factory()
    // pg-mem implements the PostgreSQL statements used by our migration and
    // repositories, but not Kysely's catalog-introspection `!~` operator.
    // Apply the production migration directly so the PostgreSQL contract still
    // exercises the complete schema without weakening the dual-dialect test.
    if (_dialect === 'postgres') {
      await applyInitialMigration(handle.db)
      await applyProviderCredentialPayloadMigration(handle.db)
    } else {
      await handle.migrateToLatest()
    }
  })

  afterEach(async () => {
    await handle.close()
  })

  it('migrates every declared entity table', async () => {
    const required = [
      'gateway_meta',
      'accounts',
      'password_credentials',
      'organizations',
      'invitations',
      'device_sessions',
      'refresh_tokens',
      'authorization_codes',
      'webview_tickets',
      'webview_sessions',
      'model_rates',
      'organization_credit_periods',
      'user_credit_allocations',
      'risk_policies',
      'turn_risks',
      'usage_records',
      'conversation_audits',
      'admin_audit_events',
      'providers',
      'provider_credentials',
      'model_routes',
      'mock_states'
    ]
    for (const table of required) {
      await expect(handle.db.selectFrom(table as 'accounts').selectAll().limit(0).execute())
        .resolves.toEqual([])
    }
  })

  it('provides identical upsert and lookup semantics', async () => {
    const repository = new GatewayMetaRepository(handle.db)
    await repository.set('contract', 'v1', '2026-07-16T00:00:00.000Z')
    expect(await repository.get('contract')).toBe('v1')
    await repository.set('contract', 'v2', '2026-07-16T00:01:00.000Z')
    expect(await repository.get('contract')).toBe('v2')
    expect(await repository.get('missing')).toBeNull()
  })

  it('commits and rolls back through the shared transaction boundary', async () => {
    await handle.inTransaction(async transaction => {
      const repository = new GatewayMetaRepository(transaction)
      await repository.set('committed', 'yes', '2026-07-16T00:02:00.000Z')
    })
    expect(await new GatewayMetaRepository(handle.db).get('committed')).toBe('yes')

    const rollback = new Error('intentional contract rollback')
    await expect(handle.inTransaction(async transaction => {
      const repository = new GatewayMetaRepository(transaction)
      await repository.set('rolled-back', 'no', '2026-07-16T00:03:00.000Z')
      throw rollback
    })).rejects.toBe(rollback)
    // SQLite verifies rollback state end-to-end. pg-mem accepts BEGIN/ROLLBACK
    // but intentionally does not implement transaction isolation/rollback;
    // the PostgreSQL branch still verifies Kysely's transaction boundary and
    // exception propagation without pretending pg-mem proves server semantics.
    if (_dialect === 'sqlite') {
      expect(await new GatewayMetaRepository(handle.db).get('rolled-back')).toBeNull()
    }
  })

  it('stores expanded credential envelopes and conditionally updates payloads', async () => {
    const repository = new ProviderRepository(
      handle.db,
      callback => handle.inTransaction(callback)
    )
    await repository.insertProvider({
      id: 'provider_contract',
      kind: 'relay',
      displayName: 'Contract Provider',
      status: 'disabled',
      config: {},
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      version: 1
    })
    const initialPayload = `{"ciphertext":"${'A'.repeat(10_000)}"}`
    await repository.insertCredential({
      id: 'credential_contract',
      providerId: 'provider_contract',
      storageKind: 'envelope-v1',
      secretPayload: initialPayload,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z'
    })
    const replacementPayload = `{"ciphertext":"${'B'.repeat(12_000)}"}`
    await expect(repository.updateCredentialPayload({
      providerId: 'provider_contract',
      credentialId: 'credential_contract',
      expectedStorageKind: 'envelope-v1',
      expectedSecretPayload: initialPayload,
      storageKind: 'envelope-v1',
      secretPayload: replacementPayload,
      updatedAt: '2026-07-21T00:01:00.000Z'
    })).resolves.toBe(true)
    await expect(repository.updateCredentialPayload({
      providerId: 'provider_contract',
      credentialId: 'credential_contract',
      expectedStorageKind: 'envelope-v1',
      expectedSecretPayload: initialPayload,
      storageKind: 'envelope-v1',
      secretPayload: 'stale-overwrite',
      updatedAt: '2026-07-21T00:02:00.000Z'
    })).resolves.toBe(false)
    expect((await repository.listCredentials())[0]?.secretPayload)
      .toBe(replacementPayload)
  })
})
