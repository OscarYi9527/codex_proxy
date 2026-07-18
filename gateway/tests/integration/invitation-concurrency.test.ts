import { HmacSha256Digest } from '../../src/common/digests.js'
import {
  beginAuthorization,
  createRealGatewayFixture,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

async function seedInvitation(
  fixture: RealGatewayFixture,
  options: {
    id: string
    code: string
    expiresAt: string
    maxUses: number
  }
): Promise<void> {
  const admin = await fixture.database.db
    .selectFrom('accounts')
    .select('id')
    .where('role', '=', 'level1')
    .executeTakeFirstOrThrow()
  await fixture.database.db.insertInto('organizations').values({
    id: 'org_invitation',
    name: 'Invitation Organization',
    status: 'active',
    billing_timezone: 'UTC',
    audit_retention_days: 30,
    overdraft_per_turn_override: null,
    cumulative_risk_override: null,
    created_at: fixture.clock.now().toISOString(),
    updated_at: fixture.clock.now().toISOString(),
    version: 1
  }).execute()
  const digest = new HmacSha256Digest(Buffer.alloc(32, 9))
  await fixture.database.db.insertInto('invitations').values({
    id: options.id,
    organization_id: 'org_invitation',
    code_digest: digest.digest('invitation', options.code),
    created_by: admin.id,
    expires_at: options.expiresAt,
    max_uses: options.maxUses,
    use_count: 0,
    status: 'active',
    created_at: fixture.clock.now().toISOString(),
    revoked_at: null,
    revoked_by: null
  }).execute()
}

describe('invitation registration boundaries (T061/T066)', () => {
  let fixture: RealGatewayFixture

  afterEach(async () => fixture.gateway.close())

  it('atomically permits only one registration for the final invitation use', async () => {
    fixture = await createRealGatewayFixture()
    await seedInvitation(fixture, {
      id: 'inv_concurrent',
      code: 'INVITE-CONCURRENT',
      expiresAt: new Date(fixture.clock.nowMs() + 60_000).toISOString(),
      maxUses: 1
    })
    const [firstAuthorization, secondAuthorization] = await Promise.all([
      beginAuthorization(fixture, { state: 'state-first-0123456789' }),
      beginAuthorization(fixture, { state: 'state-second-0123456789' })
    ])

    const responses = await Promise.all([
      fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          authorizationTransactionId: firstAuthorization.transactionId,
          invitationCode: 'INVITE-CONCURRENT',
          email: 'first@example.test',
          password: 'StrongPassword123'
        }
      }),
      fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          authorizationTransactionId: secondAuthorization.transactionId,
          invitationCode: 'INVITE-CONCURRENT',
          email: 'second@example.test',
          password: 'StrongPassword123'
        }
      })
    ])

    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1)
    const rejected = responses.find(response => response.statusCode !== 200)
    expect(rejected?.statusCode).toBeGreaterThanOrEqual(400)
    expect(rejected?.statusCode).toBeLessThan(500)
    expect(['invitation_exhausted', 'invitation_invalid'])
      .toContain(rejected?.json().error.code)

    const invitation = await fixture.database.db
      .selectFrom('invitations')
      .select(['use_count', 'status'])
      .where('id', '=', 'inv_concurrent')
      .executeTakeFirstOrThrow()
    expect(invitation).toEqual({ use_count: 1, status: 'exhausted' })
    const registered = await fixture.database.db
      .selectFrom('accounts')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('role', '=', 'user')
      .executeTakeFirstOrThrow()
    expect(Number(registered.count)).toBe(1)
  })

  it('rejects an expired invitation without consuming it', async () => {
    fixture = await createRealGatewayFixture()
    await seedInvitation(fixture, {
      id: 'inv_expired',
      code: 'INVITE-EXPIRED',
      expiresAt: new Date(fixture.clock.nowMs() - 1).toISOString(),
      maxUses: 2
    })
    const authorization = await beginAuthorization(fixture)

    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        authorizationTransactionId: authorization.transactionId,
        invitationCode: 'INVITE-EXPIRED',
        email: 'expired@example.test',
        password: 'StrongPassword123'
      }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invitation_expired')
    const invitation = await fixture.database.db
      .selectFrom('invitations')
      .select(['use_count', 'status'])
      .where('id', '=', 'inv_expired')
      .executeTakeFirstOrThrow()
    expect(invitation).toEqual({ use_count: 0, status: 'active' })
  })
})
