import { sql } from 'kysely'
import { databaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { up as applyInitialMigration } from '../../src/db/migrations/001_initial.js'
import { up as applyAuditContextMigration } from '../../src/db/migrations/002_audit_event_context.js'
import { up as applyCredentialEnvelopeMigration } from '../../src/db/migrations/003_provider_credential_envelope.js'
import { up as applyExemptTurnMigration } from '../../src/db/migrations/005_exempt_turn_settlements.js'

const historicalMigrations = [
  ['001_initial', '2026-07-20T21:52:43.182Z'],
  ['002_audit_event_context', '2026-07-20T21:52:43.183Z'],
  ['003_provider_credential_envelope', '2026-07-20T21:52:43.184Z'],
  ['005_exempt_turn_settlements', '2026-07-22T15:37:42.576Z']
] as const

async function createDivergedPreviewDatabase() {
  const db = createSqliteDatabase(':memory:')
  await applyInitialMigration(db)
  await applyAuditContextMigration(db)
  await applyCredentialEnvelopeMigration(db)
  await applyExemptTurnMigration(db)
  await db.schema.createTable('kysely_migration')
    .addColumn('name', 'varchar(255)', column => column.primaryKey())
    .addColumn('timestamp', 'varchar(255)', column => column.notNull())
    .execute()
  await db.schema.createTable('kysely_migration_lock')
    .addColumn('id', 'varchar(255)', column => column.primaryKey())
    .addColumn('is_locked', 'integer', column => column.notNull().defaultTo(0))
    .execute()
  for (const [name, timestamp] of historicalMigrations) {
    await sql`
      insert into kysely_migration (name, timestamp)
      values (${name}, ${timestamp})
    `.execute(db)
  }
  return db
}

describe('preview migration order compatibility', () => {
  it('backfills the missing 004 migration before stock Kysely validation', async () => {
    const handle = databaseHandle(await createDivergedPreviewDatabase())
    try {
      await expect(handle.migrateToLatest()).resolves.toBeUndefined()
      const executed = (
        await sql<{ name: string }>`
          select name from kysely_migration order by timestamp asc, name asc
        `.execute(handle.db)
      ).rows.map(row => row.name)
      expect(executed).toEqual([
        '001_initial',
        '002_audit_event_context',
        '003_provider_credential_envelope',
        '004_public_mvp_capacity',
        '005_exempt_turn_settlements'
      ])
      await expect(
        handle.db.selectFrom('deployment_capacity').selectAll().executeTakeFirst()
      ).resolves.toMatchObject({
        id: 'public_mvp',
        hard_limit: 30,
        admitted_account_count: 0
      })
    } finally {
      await handle.close()
    }
  })

  it('keeps production-style strict migration history fail-closed', async () => {
    const handle = databaseHandle(
      await createDivergedPreviewDatabase(),
      undefined,
      'strict'
    )
    try {
      await expect(handle.migrateToLatest()).rejects.toThrow(/corrupted migrations/i)
      const capacityTable = await handle.db.introspection.getTables()
      expect(capacityTable.some(table => table.name === 'deployment_capacity')).toBe(false)
    } finally {
      await handle.close()
    }
  })

  it('does not rewrite an unrecognized preview migration history', async () => {
    const db = await createDivergedPreviewDatabase()
    await sql`
      insert into kysely_migration (name, timestamp)
      values (${'004_unknown_branch_migration'}, ${'2026-07-21T12:00:00.000Z'})
    `.execute(db)
    const handle = databaseHandle(db)
    try {
      await expect(handle.migrateToLatest()).rejects.toThrow(/corrupted migrations/i)
      const capacityTable = await handle.db.introspection.getTables()
      expect(capacityTable.some(table => table.name === 'deployment_capacity')).toBe(false)
    } finally {
      await handle.close()
    }
  })
})
