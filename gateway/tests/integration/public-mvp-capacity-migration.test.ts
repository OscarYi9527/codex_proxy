import { databaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { up as applyInitialMigration } from '../../src/db/migrations/001_initial.js'
import { up as applyAuditContextMigration } from '../../src/db/migrations/002_audit_event_context.js'
import { up as applyCredentialEnvelopeMigration } from '../../src/db/migrations/003_provider_credential_envelope.js'
import { up as applyPublicMvpCapacityMigration } from '../../src/db/migrations/004_public_mvp_capacity.js'
import { AuthRepository } from '../../src/db/repositories/auth-repository.js'

describe('public MVP capacity migration (T139)', () => {
  it('initializes the hard cap from every existing product account', async () => {
    const database = databaseHandle(createSqliteDatabase(':memory:'))
    try {
      await applyInitialMigration(database.db)
      await applyAuditContextMigration(database.db)
      await applyCredentialEnvelopeMigration(database.db)
      const now = '2026-07-21T00:00:00.000Z'
      await database.db.insertInto('accounts').values([
        {
          id: 'acct_existing_admin',
          login_name: 'admin',
          email: null,
          role: 'level1',
          organization_id: null,
          status: 'active',
          expires_at: null,
          must_change_password: 1,
          must_provide_email: 1,
          created_at: now,
          updated_at: now,
          disabled_at: null,
          disabled_by: null,
          version: 1
        },
        {
          id: 'acct_existing_disabled_user',
          login_name: null,
          email: 'disabled@example.test',
          role: 'user',
          organization_id: null,
          status: 'disabled',
          expires_at: null,
          must_change_password: 0,
          must_provide_email: 0,
          created_at: now,
          updated_at: now,
          disabled_at: now,
          disabled_by: 'acct_existing_admin',
          version: 2
        }
      ]).execute()

      await applyPublicMvpCapacityMigration(database.db)

      await expect(new AuthRepository(database.db).getPublicMvpCapacity())
        .resolves.toMatchObject({
          hardLimit: 30,
          admittedAccountCount: 2,
          longTermCoreReady: false
        })
    } finally {
      await database.close()
    }
  })
})
