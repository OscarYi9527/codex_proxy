import type { Kysely } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

export async function up(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.createTable('exempt_turns')
    .ifNotExists()
    .addColumn('turn_id', 'varchar(160)', column => column.primaryKey())
    .addColumn('account_id', 'varchar(160)', column =>
      column.notNull().references('accounts.id'))
    .addColumn('device_session_id', 'varchar(160)', column =>
      column.notNull().references('device_sessions.id'))
    .addColumn('model_id', 'varchar(240)', column => column.notNull())
    .addColumn('settlement_id', 'varchar(160)', column => column.notNull().unique())
    .addColumn('status', 'varchar(20)', column => column.notNull())
    .addColumn('provider_id', 'varchar(160)')
    .addColumn('input_tokens', 'integer')
    .addColumn('output_tokens', 'integer')
    .addColumn('created_at', 'varchar(40)', column => column.notNull())
    .addColumn('started_at', 'varchar(40)')
    .addColumn('finished_at', 'varchar(40)')
    .addColumn('failure_code', 'varchar(120)')
    .execute()

  await db.schema.createIndex('exempt_turns_account_status_idx')
    .ifNotExists()
    .on('exempt_turns')
    .columns(['account_id', 'status'])
    .execute()
}

export async function down(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.dropTable('exempt_turns').ifExists().execute()
}
