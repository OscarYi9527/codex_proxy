import type { Kysely } from 'kysely'
import type { GatewayDatabase } from '../schema.js'

export class GatewayMetaRepository {
  readonly #db: Kysely<GatewayDatabase>

  constructor(db: Kysely<GatewayDatabase>) {
    this.#db = db
  }

  async set(key: string, value: string, updatedAt: string): Promise<void> {
    await this.#db.insertInto('gateway_meta')
      .values({ key, value, updated_at: updatedAt })
      .onConflict(conflict => conflict.column('key').doUpdateSet({ value, updated_at: updatedAt }))
      .execute()
  }

  async get(key: string): Promise<string | null> {
    const row = await this.#db.selectFrom('gateway_meta')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return row?.value ?? null
  }
}
