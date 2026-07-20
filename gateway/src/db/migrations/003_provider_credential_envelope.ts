import type { Kysely } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

export async function up(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.alterTable('provider_credentials')
    .addColumn('key_version', 'varchar(120)')
    .execute()
  await db.schema.alterTable('provider_credentials')
    .addColumn(
      'credential_version',
      'integer',
      column => column.notNull().defaultTo(1)
    )
    .execute()
  await db.schema.createIndex('provider_credentials_storage_key_idx')
    .ifNotExists()
    .on('provider_credentials')
    .columns(['storage_kind', 'key_version'])
    .execute()
}

export async function down(db: Kysely<GatewayDatabase>): Promise<void> {
  await db.schema.dropIndex('provider_credentials_storage_key_idx')
    .ifExists()
    .execute()
  await db.schema.alterTable('provider_credentials')
    .dropColumn('credential_version')
    .execute()
  await db.schema.alterTable('provider_credentials')
    .dropColumn('key_version')
    .execute()
}
