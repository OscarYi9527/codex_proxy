import type { Kysely } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

const PUBLIC_MVP_CAPACITY_ID = 'public_mvp'
const PUBLIC_MVP_ACCOUNT_LIMIT = 30

export async function up(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.createTable('deployment_capacity')
    .ifNotExists()
    .addColumn('id', 'varchar(80)', column => column.primaryKey())
    .addColumn('hard_limit', 'integer', column => column.notNull())
    .addColumn('admitted_account_count', 'integer', column => column.notNull())
    .addColumn('long_term_core_ready', 'integer', column => column.notNull().defaultTo(0))
    .addColumn('created_at', 'varchar(40)', column => column.notNull())
    .addColumn('updated_at', 'varchar(40)', column => column.notNull())
    .addColumn('version', 'integer', column => column.notNull().defaultTo(1))
    .execute()

  const existing = await db
    .selectFrom('accounts')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  const now = new Date().toISOString()
  await db.insertInto('deployment_capacity').values({
    id: PUBLIC_MVP_CAPACITY_ID,
    hard_limit: PUBLIC_MVP_ACCOUNT_LIMIT,
    admitted_account_count: Number(existing.count),
    long_term_core_ready: 0,
    created_at: now,
    updated_at: now,
    version: 1
  }).onConflict(conflict => conflict.column('id').doNothing()).execute()
}

export async function down(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.dropTable('deployment_capacity').ifExists().execute()
}
