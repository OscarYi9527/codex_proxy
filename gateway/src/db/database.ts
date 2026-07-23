import {
  Kysely,
  Migrator,
  sql,
  type Migration,
  type MigrationProvider,
  type Transaction
} from 'kysely'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { GatewayConfig } from '../config.js'
import {
  createPostgresDatabase,
  verifyPostgresRuntimeRoleSecurity
} from './dialects/postgres.js'
import { createSqliteDatabase } from './dialects/sqlite.js'
import { up as applyPublicMvpCapacityMigration } from './migrations/004_public_mvp_capacity.js'
import type { GatewayDatabase } from './schema.js'

type MigrationCompatibilityMode = 'repair-preview' | 'strict'

export interface DatabaseHandle {
  readonly db: Kysely<GatewayDatabase>
  inTransaction<T>(
    callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
  ): Promise<T>
  migrateToLatest(): Promise<void>
  verifyRuntimeSecurity(): Promise<void>
  close(): Promise<void>
}

class FileUrlMigrationProvider implements MigrationProvider {
  constructor(private readonly migrationFolder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {}
    const fileNames = await fs.readdir(this.migrationFolder)
    for (const fileName of fileNames.sort()) {
      if (!/\.(?:js|mjs|ts|mts)$/.test(fileName) || /\.d\.(?:ts|mts)$/.test(fileName)) continue
      const module = await import(pathToFileURL(path.join(this.migrationFolder, fileName)).href) as {
        default?: Migration
        up?: Migration['up']
        down?: Migration['down']
      }
      const migration = typeof module.default?.up === 'function'
        ? module.default
        : { up: module.up, down: module.down }
      if (typeof migration.up !== 'function') continue
      migrations[fileName.slice(0, fileName.lastIndexOf('.'))] = migration as Migration
    }
    return migrations
  }
}

export function createGatewayDatabase(config: GatewayConfig): DatabaseHandle {
  const db = config.database.dialect === 'postgres'
    ? createPostgresDatabase({
        connectionString: config.database.postgresUrl as string,
        ...(config.database.postgresTls ? { tls: config.database.postgresTls } : {})
      })
    : createSqliteDatabase(config.database.sqliteFile)
  return databaseHandle(
    db,
    config.environment === 'production' && config.database.dialect === 'postgres'
      ? () => verifyPostgresRuntimeRoleSecurity(db)
      : undefined,
    config.environment === 'production' || config.environment === 'preproduction'
      ? 'strict'
      : 'repair-preview'
  )
}

export function databaseHandle(
  db: Kysely<GatewayDatabase>,
  runtimeSecurityVerifier?: () => Promise<void>,
  migrationCompatibilityMode: MigrationCompatibilityMode = 'repair-preview'
): DatabaseHandle {
  return {
    db,
    async inTransaction<T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ): Promise<T> {
      return db.transaction().execute(callback)
    },
    async migrateToLatest() {
      if (migrationCompatibilityMode === 'repair-preview') {
        await repairPreviewMigrationOrder(db)
      }
      const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')
      const migrator = new Migrator({
        db,
        // Kysely's stock file provider imports Windows drive paths directly.
        // Node 24 rejects `F:\...` as an unsupported URL scheme, so always
        // convert migration paths to file:// URLs before dynamic import.
        provider: new FileUrlMigrationProvider(migrationFolder)
      })
      const { error, results } = await migrator.migrateToLatest()
      for (const result of results || []) {
        if (result.status === 'Error') throw new Error(`Migration failed: ${result.migrationName}`)
      }
      if (error) throw error
    },
    async verifyRuntimeSecurity() {
      await runtimeSecurityVerifier?.()
    },
    async close() {
      await db.destroy()
    }
  }
}

interface ExecutedMigration {
  readonly name: string
  readonly timestamp: string
}

/**
 * A preview-only Ubuntu branch executed migration 005 before migration 004
 * existed in that branch. Kysely correctly refuses such a database after the
 * branches converge because its executed list is no longer a prefix of the
 * sorted migration catalog. Repair only this exact, known-safe gap before the
 * stock migrator runs. Production remains strict and requires an operator
 * migration instead of silently rewriting migration history.
 */
async function repairPreviewMigrationOrder(db: Kysely<GatewayDatabase>): Promise<void> {
  const tables = await db.introspection.getTables({ withInternalKyselyTables: true })
  if (!tables.some(table => table.name === 'kysely_migration')) return

  const executed = (
    await sql<ExecutedMigration>`
      select name, timestamp
      from kysely_migration
      order by timestamp asc, name asc
    `.execute(db)
  ).rows
  const executedNames = executed.map(migration => migration.name)
  const knownDivergedHistory = [
    '001_initial',
    '002_audit_event_context',
    '003_provider_credential_envelope',
    '005_exempt_turn_settlements'
  ]
  if (
    executedNames.length !== knownDivergedHistory.length ||
    executedNames.some((name, index) => name !== knownDivergedHistory[index])
  ) {
    return
  }

  const exemptMigration = executed.find(
    migration => migration.name === '005_exempt_turn_settlements'
  )
  if (!exemptMigration) return
  const exemptIndex = executed.indexOf(exemptMigration)
  const previousTimestamp = exemptIndex > 0
    ? executed[exemptIndex - 1]?.timestamp
    : undefined
  const compatibilityTimestamp = timestampBefore(
    exemptMigration.timestamp,
    previousTimestamp
  )

  await db.transaction().execute(async transaction => {
    await applyPublicMvpCapacityMigration(transaction)
    await sql`
      insert into kysely_migration (name, timestamp)
      values (${'004_public_mvp_capacity'}, ${compatibilityTimestamp})
    `.execute(transaction)
  })
}

function timestampBefore(nextValue: string, previousValue?: string): string {
  const next = Date.parse(nextValue)
  const previous = previousValue ? Date.parse(previousValue) : Number.NaN
  if (Number.isFinite(previous) && Number.isFinite(next) && previous < next) {
    return new Date(previous + Math.max(1, Math.floor((next - previous) / 2))).toISOString()
  }
  if (Number.isFinite(next)) {
    return new Date(next - 1).toISOString()
  }
  throw new Error('Preview migration compatibility repair requires valid migration timestamps.')
}
