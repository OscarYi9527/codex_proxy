import { newDb } from 'pg-mem'
import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createPostgresDatabase } from '../../src/db/dialects/postgres.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { up as applyInitialMigration } from '../../src/db/migrations/001_initial.js'
import {
  up as applyProviderCredentialPayloadMigration
} from '../../src/db/migrations/002_provider_credential_payload_text.js'
import {
  OrganizationRepository,
  type OrganizationRecord
} from '../../src/db/repositories/organization-repository.js'

type Factory = () => DatabaseHandle

const factories: Array<[string, Factory]> = [
  ['sqlite', () => databaseHandle(createSqliteDatabase(':memory:'))],
  ['postgres', () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true })
    const adapter = memory.adapters.createPg()
    return databaseHandle(createPostgresDatabase({ pool: new adapter.Pool() }))
  }]
]

const now = '2026-07-21T00:00:00.000Z'

function organization(id: string, name: string): OrganizationRecord {
  return {
    id,
    name,
    status: 'active',
    billingTimezone: 'Asia/Shanghai',
    auditRetentionDays: 30,
    createdAt: now,
    updatedAt: now,
    version: 1
  }
}

describe.each(factories)('%s organization repository contract', (dialect, factory) => {
  let handle: DatabaseHandle
  let repository: OrganizationRepository

  beforeEach(async () => {
    handle = factory()
    if (dialect === 'postgres') {
      await applyInitialMigration(handle.db)
      await applyProviderCredentialPayloadMigration(handle.db)
    } else {
      await handle.migrateToLatest()
    }
    repository = new OrganizationRepository(
      handle.db,
      callback => handle.inTransaction(callback)
    )
    await repository.insertOrganization(organization('org_a', 'Organization A'))
    await repository.insertOrganization(organization('org_b', 'Organization B'))
    await handle.db.insertInto('accounts').values([
      {
        id: 'acct_global_level1',
        login_name: 'admin',
        email: 'admin@example.test',
        role: 'level1',
        organization_id: null,
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: now,
        updated_at: now,
        disabled_at: null,
        disabled_by: null,
        version: 1
      },
      {
        id: 'acct_org_level1',
        login_name: null,
        email: 'org-admin@example.test',
        role: 'level1',
        organization_id: 'org_a',
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: now,
        updated_at: now,
        disabled_at: null,
        disabled_by: null,
        version: 1
      },
      {
        id: 'acct_level2_a',
        login_name: null,
        email: 'level2-a@example.test',
        role: 'level2',
        organization_id: 'org_a',
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: now,
        updated_at: now,
        disabled_at: null,
        disabled_by: null,
        version: 1
      },
      {
        id: 'acct_user_a',
        login_name: null,
        email: 'user-a@example.test',
        role: 'user',
        organization_id: 'org_a',
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: now,
        updated_at: now,
        disabled_at: null,
        disabled_by: null,
        version: 1
      },
      {
        id: 'acct_user_b',
        login_name: null,
        email: 'user-b@example.test',
        role: 'user',
        organization_id: 'org_b',
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: now,
        updated_at: now,
        disabled_at: null,
        disabled_by: null,
        version: 1
      }
    ]).execute()
  })

  afterEach(async () => {
    await handle.close()
  })

  it('requires explicit organization scopes for account reads and writes', async () => {
    const scopeA = { kind: 'organization', organizationId: 'org_a' } as const
    expect((await repository.listAccounts(scopeA)).map(account => account.id))
      .toEqual([
        'acct_org_level1',
        'acct_level2_a',
        'acct_user_a'
      ])
    expect((await repository.listAccounts(scopeA, {
      ordinaryUsersOnly: true
    })).map(account => account.id)).toEqual(['acct_user_a'])
    expect(await repository.getAccount(scopeA, 'acct_user_b')).toBeNull()
    expect(await repository.updateAccount(
      scopeA,
      'acct_user_b',
      { status: 'disabled', updatedAt: now },
      { ordinaryUsersOnly: true }
    )).toBe(false)
    expect((await repository.getAccount(
      { kind: 'all' },
      'acct_user_b'
    ))?.status).toBe('active')
  })

  it('counts only active, unexpired Level-1 accounts in active organizations', async () => {
    await expect(repository.countEffectiveLevel1(now)).resolves.toBe(2)
    await repository.inTransaction(async transactionRepository => {
      await transactionRepository.serializeLevel1Invariant(now)
      await transactionRepository.updateOrganization(
        { kind: 'all' },
        'org_a',
        { status: 'disabled', updatedAt: now }
      )
      await expect(transactionRepository.countEffectiveLevel1(now)).resolves.toBe(1)
    })
  })

  it('stores only invitation digests and scopes revocation', async () => {
    await repository.insertInvitation({
      id: 'inv_a',
      organizationId: 'org_a',
      codeDigest: 'digest-only-value',
      createdBy: 'acct_level2_a',
      expiresAt: '2026-07-22T00:00:00.000Z',
      maxUses: 2,
      createdAt: now
    })
    const scopeA = { kind: 'organization', organizationId: 'org_a' } as const
    const scopeB = { kind: 'organization', organizationId: 'org_b' } as const
    expect(await repository.getInvitation(scopeB, 'inv_a', now)).toBeNull()
    expect(await repository.revokeInvitation({
      scope: scopeB,
      invitationId: 'inv_a',
      revokedAt: now,
      revokedBy: 'acct_user_b'
    })).toBe(false)
    expect(await repository.revokeInvitation({
      scope: scopeA,
      invitationId: 'inv_a',
      revokedAt: now,
      revokedBy: 'acct_level2_a'
    })).toBe(true)
    expect(await repository.getInvitation(scopeA, 'inv_a', now))
      .toMatchObject({
        id: 'inv_a',
        organizationId: 'org_a',
        status: 'revoked',
        useCount: 0
      })
  })
})
