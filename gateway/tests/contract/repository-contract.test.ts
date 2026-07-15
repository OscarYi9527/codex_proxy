import { newDb } from 'pg-mem'
import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createPostgresDatabase } from '../../src/db/dialects/postgres.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { up as applyInitialMigration } from '../../src/db/migrations/001_initial.js'
import { GatewayMetaRepository } from '../../src/db/repositories/gateway-meta-repository.js'

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
    } else {
      await handle.migrateToLatest()
    }
  })

  afterEach(async () => {
    await handle.close()
  })

  it('migrates every declared entity table', async () => {
    const required = [
      'accounts',
      'organizations',
      'invitations',
      'device_sessions',
      'refresh_tokens',
      'authorization_codes',
      'webview_tickets',
      'organization_credit_periods',
      'turn_risks',
      'usage_records',
      'conversation_audits',
      'providers',
      'provider_credentials',
      'model_routes'
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
})
