import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { GatewayDatabase } from '../schema.js'

export interface PostgresPoolLike {
  connect(): Promise<unknown>
  end(): Promise<void>
}

export function createPostgresDatabase(options: {
  connectionString?: string
  pool?: PostgresPoolLike
}): Kysely<GatewayDatabase> {
  if (!options.pool && !options.connectionString) {
    throw new Error('PostgreSQL requires a connection string or pool')
  }
  const pool = options.pool || new pg.Pool({
    connectionString: options.connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  })
  return new Kysely<GatewayDatabase>({
    dialect: new PostgresDialect({
      pool: pool as ConstructorParameters<typeof PostgresDialect>[0]['pool']
    })
  })
}
