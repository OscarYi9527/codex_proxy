import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'

export async function createCreditDatabase(): Promise<DatabaseHandle> {
  const database = databaseHandle(createSqliteDatabase(':memory:'))
  await database.migrateToLatest()
  return database
}

export async function seedCreditIdentity(database: DatabaseHandle, options: {
  organizationId?: string
  accountId?: string
  deviceSessionId?: string
  role?: 'level1' | 'level2' | 'user'
  now?: string
} = {}): Promise<{
  organizationId: string
  accountId: string
  deviceSessionId: string
}> {
  const organizationId = options.organizationId || 'org_credit_test'
  const accountId = options.accountId || 'acct_credit_test'
  const deviceSessionId = options.deviceSessionId || 'ds_credit_test'
  const now = options.now || '2026-07-18T00:00:00.000Z'
  await database.db.insertInto('organizations').values({
    id: organizationId,
    name: `Credit organization ${organizationId}`,
    status: 'active',
    billing_timezone: 'Asia/Shanghai',
    audit_retention_days: 30,
    overdraft_per_turn_override: null,
    cumulative_risk_override: null,
    created_at: now,
    updated_at: now,
    version: 1
  }).execute()
  await database.db.insertInto('accounts').values({
    id: accountId,
    login_name: null,
    email: `${accountId}@example.test`,
    role: options.role || 'user',
    organization_id: organizationId,
    status: 'active',
    expires_at: null,
    must_change_password: 0,
    must_provide_email: 0,
    created_at: now,
    updated_at: now,
    disabled_at: null,
    disabled_by: null,
    version: 1
  }).execute()
  await database.db.insertInto('password_credentials').values({
    account_id: accountId,
    password_hash: 'test-only',
    kind: 'permanent',
    created_at: now,
    used_at: null,
    expires_at: null,
    password_version: 1
  }).execute()
  await database.db.insertInto('device_sessions').values({
    id: deviceSessionId,
    account_id: accountId,
    device_name: 'Credit test device',
    platform: 'windows',
    created_at: now,
    last_used_at: now,
    expires_at: '2027-07-18T00:00:00.000Z',
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    password_version: 1
  }).execute()
  return { organizationId, accountId, deviceSessionId }
}

