import { HmacSha256Digest } from '../../src/common/digests.js'
import {
  beginAuthorization,
  createRealGatewayFixture,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('invitation atomic consumption and lifecycle (T061)', () => {
  let fixture: RealGatewayFixture
  const digest = new HmacSha256Digest(Buffer.alloc(32, 9))

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  async function seedInvitation(options: {
    code: string
    expiresAt: string
    maxUses: number
    organizationStatus?: 'active' | 'disabled'
  }): Promise<{ organizationId: string; invitationId: string }> {
    const creator = await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('login_name', '=', 'admin')
      .executeTakeFirstOrThrow()
    const suffix = options.code.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    const organizationId = `org_${suffix}`
    const invitationId = `inv_${suffix}`
    const now = fixture.clock.now().toISOString()
    await fixture.database.db.insertInto('organizations').values({
      id: organizationId,
      name: `Organization ${suffix}`,
      status: options.organizationStatus || 'active',
      billing_timezone: 'Asia/Shanghai',
      audit_retention_days: 30,
      overdraft_per_turn_override: null,
      cumulative_risk_override: null,
      created_at: now,
      updated_at: now,
      version: 1
    }).execute()
    await fixture.database.db.insertInto('invitations').values({
      id: invitationId,
      organization_id: organizationId,
      code_digest: digest.digest('invitation', options.code),
      created_by: creator.id,
      expires_at: options.expiresAt,
      max_uses: options.maxUses,
      use_count: 0,
      status: 'active',
      created_at: now,
      revoked_at: null,
      revoked_by: null
    }).execute()
    return { organizationId, invitationId }
  }

  it('allows only one concurrent registration to consume the final use', async () => {
    const code = 'CONCURRENT-ONE-USE'
    const { organizationId, invitationId } = await seedInvitation({
      code,
      expiresAt: '2026-07-18T00:00:00.000Z',
      maxUses: 1
    })
    const first = await beginAuthorization(fixture, {
      state: 'concurrent-state-0000001',
      redirectUri: 'http://127.0.0.1:54321/callback'
    })
    const second = await beginAuthorization(fixture, {
      state: 'concurrent-state-0000002',
      redirectUri: 'http://127.0.0.1:54322/callback'
    })
    const responses = await Promise.all([
      fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          authorizationTransactionId: first.transactionId,
          invitationCode: code,
          email: 'concurrent-a@example.com',
          password: 'ConcurrentPassword123'
        }
      }),
      fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          authorizationTransactionId: second.transactionId,
          invitationCode: code,
          email: 'concurrent-b@example.com',
          password: 'ConcurrentPassword123'
        }
      })
    ])
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 400])
    expect(responses.find(response => response.statusCode === 400)?.json().error.code)
      .toBe('invitation_exhausted')
    const accounts = await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute()
    expect(accounts).toHaveLength(1)
    const invitation = await fixture.database.db
      .selectFrom('invitations')
      .select(['use_count', 'status'])
      .where('id', '=', invitationId)
      .executeTakeFirstOrThrow()
    expect(invitation).toEqual({ use_count: 1, status: 'exhausted' })
  }, 20_000)

  it('does not consume expired invitations or invitations for disabled organizations', async () => {
    const expired = await seedInvitation({
      code: 'EXPIRED-INVITATION',
      expiresAt: '2026-07-16T23:59:59.000Z',
      maxUses: 2
    })
    const disabled = await seedInvitation({
      code: 'DISABLED-ORGANIZATION',
      expiresAt: '2026-07-18T00:00:00.000Z',
      maxUses: 2,
      organizationStatus: 'disabled'
    })
    for (const [index, options] of [
      {
        invitationCode: 'EXPIRED-INVITATION',
        email: 'expired@example.com',
        expectedCode: 'invitation_expired'
      },
      {
        invitationCode: 'DISABLED-ORGANIZATION',
        email: 'disabled@example.com',
        expectedCode: 'invitation_invalid'
      }
    ].entries()) {
      const authorization = await beginAuthorization(fixture, {
        state: `lifecycle-state-00000${index}`,
        redirectUri: `http://127.0.0.1:${54400 + index}/callback`
      })
      const response = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          authorizationTransactionId: authorization.transactionId,
          invitationCode: options.invitationCode,
          email: options.email,
          password: 'LifecyclePassword123'
        }
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe(options.expectedCode)
    }
    const invitations = await fixture.database.db
      .selectFrom('invitations')
      .select(['id', 'use_count'])
      .where('id', 'in', [expired.invitationId, disabled.invitationId])
      .execute()
    expect(invitations.every(invitation => invitation.use_count === 0)).toBe(true)
  }, 20_000)
})
