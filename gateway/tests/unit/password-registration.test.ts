import { HmacSha256Digest } from '../../src/common/digests.js'
import {
  beginAuthorization,
  createRealGatewayFixture,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('Argon2id bootstrap and invitation registration (T024)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('creates admin once with Argon2id and never stores its one-time password', async () => {
    const account = await fixture.database.db
      .selectFrom('accounts')
      .selectAll()
      .where('login_name', '=', 'admin')
      .executeTakeFirstOrThrow()
    const credential = await fixture.database.db
      .selectFrom('password_credentials')
      .selectAll()
      .where('account_id', '=', account.id)
      .executeTakeFirstOrThrow()
    expect(credential.kind).toBe('bootstrap')
    expect(credential.password_hash).toMatch(/^\$argon2id\$/)
    expect(credential.password_hash).not.toContain(fixture.bootstrap.password)
    expect(account.must_change_password).toBe(1)
    expect(account.must_provide_email).toBe(1)
  })

  it('atomically consumes an invitation and creates a permanent user', async () => {
    const admin = await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('login_name', '=', 'admin')
      .executeTakeFirstOrThrow()
    await fixture.database.db.insertInto('organizations').values({
      id: 'org_registration',
      name: 'Registration Org',
      status: 'active',
      billing_timezone: 'Asia/Shanghai',
      audit_retention_days: 30,
      overdraft_per_turn_override: null,
      cumulative_risk_override: null,
      created_at: fixture.clock.now().toISOString(),
      updated_at: fixture.clock.now().toISOString(),
      version: 1
    }).execute()
    const digest = new HmacSha256Digest(Buffer.alloc(32, 9))
    await fixture.database.db.insertInto('invitations').values({
      id: 'inv_registration',
      organization_id: 'org_registration',
      code_digest: digest.digest('invitation', 'INVITE-REAL-123'),
      created_by: admin.id,
      expires_at: new Date(fixture.clock.nowMs() + 60_000).toISOString(),
      max_uses: 1,
      use_count: 0,
      status: 'active',
      created_at: fixture.clock.now().toISOString(),
      revoked_at: null,
      revoked_by: null
    }).execute()
    const authorization = await beginAuthorization(fixture)
    const registered = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        authorizationTransactionId: authorization.transactionId,
        invitationCode: 'INVITE-REAL-123',
        email: 'user@example.com',
        password: 'StrongPassword123'
      }
    })
    expect(registered.statusCode).toBe(200)
    expect(registered.json().redirectUri).toContain('code=')
    const account = await fixture.database.db
      .selectFrom('accounts')
      .selectAll()
      .where('email', '=', 'user@example.com')
      .executeTakeFirstOrThrow()
    expect(account.organization_id).toBe('org_registration')
    const credential = await fixture.database.db
      .selectFrom('password_credentials')
      .selectAll()
      .where('account_id', '=', account.id)
      .executeTakeFirstOrThrow()
    expect(credential.kind).toBe('permanent')
    expect(credential.password_hash).toMatch(/^\$argon2id\$/)
    const invitation = await fixture.database.db
      .selectFrom('invitations')
      .select(['use_count', 'status'])
      .where('id', '=', 'inv_registration')
      .executeTakeFirstOrThrow()
    expect(invitation).toEqual({ use_count: 1, status: 'exhausted' })
  })

  it('rejects weak passwords without consuming the invitation', async () => {
    const authorization = await beginAuthorization(fixture)
    const rejected = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        authorizationTransactionId: authorization.transactionId,
        invitationCode: 'anything',
        email: 'user@example.com',
        password: 'weak'
      }
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error.code).toBe('password_policy_failed')
  })
})
