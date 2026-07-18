import type { Kysely } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

export async function up(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.alterTable('admin_audit_events')
    .addColumn(
      'actor_role',
      'varchar(20)',
      column => column.notNull().defaultTo('level1')
    )
    .execute()
  await db.schema.alterTable('admin_audit_events')
    .addColumn('error_code', 'varchar(120)')
    .execute()
  await db.schema.createIndex('admin_audit_scope_created_idx')
    .ifNotExists()
    .on('admin_audit_events')
    .columns(['organization_id', 'created_at'])
    .execute()
}

export async function down(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.dropIndex('admin_audit_scope_created_idx').ifExists().execute()
  await db.schema.alterTable('admin_audit_events').dropColumn('error_code').execute()
  await db.schema.alterTable('admin_audit_events').dropColumn('actor_role').execute()
}
