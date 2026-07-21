import { sql, type Kysely } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

function isPostgres(db: Kysely<GatewayDatabase>): boolean {
  return /postgres/i.test(db.getExecutor().adapter.constructor.name)
}

export async function up(db: Kysely<GatewayDatabase>): Promise<void> {
  // SQLite does not enforce VARCHAR lengths, while existing PostgreSQL
  // installations created by 001 used varchar(4096). AES-GCM envelopes grow
  // through Base64 encoding, so only PostgreSQL requires an in-place widening.
  if (!isPostgres(db)) return
  await sql`
    alter table provider_credentials
    alter column secret_payload type text
  `.execute(db)
}
