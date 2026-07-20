import fs from 'node:fs'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { PostgresTlsConfig } from '../../config.js'
import type { GatewayDatabase } from '../schema.js'

export interface PostgresPoolLike {
  connect(): Promise<unknown>
  end(): Promise<void>
}

export function createPostgresDatabase(options: {
  connectionString?: string
  pool?: PostgresPoolLike
  tls?: PostgresTlsConfig
}): Kysely<GatewayDatabase> {
  if (!options.pool && !options.connectionString) {
    throw new Error('PostgreSQL requires a connection string or pool')
  }
  const pool = options.pool || new pg.Pool(buildPostgresPoolConfig({
    connectionString: options.connectionString as string,
    ...(options.tls ? { tls: options.tls } : {})
  }))
  return new Kysely<GatewayDatabase>({
    dialect: new PostgresDialect({
      pool: pool as ConstructorParameters<typeof PostgresDialect>[0]['pool']
    })
  })
}

export function buildPostgresPoolConfig(options: {
  connectionString: string
  tls?: PostgresTlsConfig
}): pg.PoolConfig {
  const tls = options.tls
  if (Boolean(tls?.certFile) !== Boolean(tls?.keyFile)) {
    throw new Error('PostgreSQL client TLS certificate and key must be configured together')
  }
  return {
    connectionString: options.connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(tls ? {
      ssl: {
        ca: fs.readFileSync(tls.caFile, 'utf8'),
        rejectUnauthorized: true,
        ...(tls.certFile ? { cert: fs.readFileSync(tls.certFile, 'utf8') } : {}),
        ...(tls.keyFile ? { key: fs.readFileSync(tls.keyFile, 'utf8') } : {}),
        ...(tls.serverName ? { servername: tls.serverName } : {})
      }
    } : {})
  }
}
