import {
  Kysely,
  Migrator,
  type Migration,
  type MigrationProvider,
  type Transaction
} from 'kysely'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { GatewayConfig } from '../config.js'
import { createPostgresDatabase } from './dialects/postgres.js'
import { createSqliteDatabase } from './dialects/sqlite.js'
import type { GatewayDatabase } from './schema.js'

export interface DatabaseHandle {
  readonly db: Kysely<GatewayDatabase>
  inTransaction<T>(
    callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
  ): Promise<T>
  migrateToLatest(): Promise<void>
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
    ? createPostgresDatabase({ connectionString: config.database.postgresUrl as string })
    : createSqliteDatabase(config.database.sqliteFile)
  return databaseHandle(db)
}

export function databaseHandle(db: Kysely<GatewayDatabase>): DatabaseHandle {
  return {
    db,
    async inTransaction<T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ): Promise<T> {
      return db.transaction().execute(callback)
    },
    async migrateToLatest() {
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
    async close() {
      await db.destroy()
    }
  }
}
