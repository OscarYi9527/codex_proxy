import fs from 'node:fs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { PostgresTlsConfig } from '../../config.js'
import type { GatewayDatabase } from '../schema.js'

export interface PostgresPoolLike {
  connect(): Promise<unknown>
  end(): Promise<void>
}

export interface PostgresRuntimeRoleSecurity {
  readonly superuser: boolean
  readonly createRole: boolean
  readonly createDatabase: boolean
  readonly replication: boolean
  readonly bypassRls: boolean
  readonly databaseCreate: boolean
  readonly databaseTemporary: boolean
  readonly schemaCreate: boolean
  readonly ownsApplicationObjects: boolean
  readonly readServerFiles: boolean
  readonly writeServerFiles: boolean
  readonly executeServerProgram: boolean
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

export async function verifyPostgresRuntimeRoleSecurity(
  db: Kysely<GatewayDatabase>
): Promise<void> {
  const result = await sql<PostgresRuntimeRoleSecurity>`
    select
      role.rolsuper as "superuser",
      role.rolcreaterole as "createRole",
      role.rolcreatedb as "createDatabase",
      role.rolreplication as "replication",
      role.rolbypassrls as "bypassRls",
      has_database_privilege(current_user, current_database(), 'CREATE') as "databaseCreate",
      has_database_privilege(current_user, current_database(), 'TEMP') as "databaseTemporary",
      coalesce(
        has_schema_privilege(current_user, current_schema(), 'CREATE'),
        false
      ) as "schemaCreate",
      exists (
        select 1
        from pg_class as object
        inner join pg_namespace as namespace
          on namespace.oid = object.relnamespace
        where namespace.nspname = current_schema()
          and pg_get_userbyid(object.relowner) = current_user
          and object.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      ) as "ownsApplicationObjects",
      pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') as "readServerFiles",
      pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') as "writeServerFiles",
      pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') as "executeServerProgram"
    from pg_roles as role
    where role.rolname = current_user
  `.execute(db)
  const snapshot = result.rows[0]
  if (!snapshot) {
    throw new Error('Production PostgreSQL runtime role could not be inspected')
  }
  assertPostgresRuntimeRoleLeastPrivilege(snapshot)
}

export function assertPostgresRuntimeRoleLeastPrivilege(
  snapshot: PostgresRuntimeRoleSecurity
): void {
  const privileged = Object.entries(snapshot)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
  if (privileged.length > 0) {
    throw new Error(
      `Production PostgreSQL runtime role is over-privileged: ${privileged.join(', ')}`
    )
  }
}
