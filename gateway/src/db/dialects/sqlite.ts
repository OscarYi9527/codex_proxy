import fs from 'node:fs'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

export function createSqliteDatabase(filename: string): Kysely<GatewayDatabase> {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 })
  }
  const database = new BetterSqlite3(filename)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  return new Kysely<GatewayDatabase>({
    dialect: new SqliteDialect({ database })
  })
}
