import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('rolling Refresh Token family and replay detection (T025)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('rotates every refresh and revokes the family when a consumed token is replayed', async () => {
    const initial = await loginBootstrapAndExchange(fixture)
    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${initial.accessToken}` },
      payload: {
        currentPassword: fixture.bootstrap.password,
        newPassword: 'PermanentPassword123',
        email: 'admin@example.com'
      }
    })
    expect(changed.statusCode).toBe(200)
    const permanent = changed.json()

    const first = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'refresh_token',
        clientId: 'ai-editor-edge',
        refreshToken: permanent.refreshToken,
        deviceSessionId: permanent.deviceSessionId
      }
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().refreshToken).not.toBe(permanent.refreshToken)

    const replay = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'refresh_token',
        clientId: 'ai-editor-edge',
        refreshToken: permanent.refreshToken,
        deviceSessionId: permanent.deviceSessionId
      }
    })
    expect(replay.statusCode).toBe(401)
    expect(replay.json().error.code).toBe('refresh_token_reuse_detected')

    const childAfterReplay = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'refresh_token',
        clientId: 'ai-editor-edge',
        refreshToken: first.json().refreshToken,
        deviceSessionId: first.json().deviceSessionId
      }
    })
    expect(childAfterReplay.statusCode).toBe(401)
    const session = await fixture.database.db
      .selectFrom('device_sessions')
      .select(['revoked_at', 'revoke_reason'])
      .where('id', '=', permanent.deviceSessionId)
      .executeTakeFirstOrThrow()
    expect(session.revoked_at).not.toBeNull()
    expect(session.revoke_reason).toBe('refresh_token_reuse_detected')
  })

  it('stores only keyed token digests in the database', async () => {
    const issued = await loginBootstrapAndExchange(fixture)
    const rows = await fixture.database.db
      .selectFrom('refresh_tokens')
      .select('token_digest')
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token_digest).not.toContain(issued.refreshToken)
    expect(JSON.stringify(rows)).not.toContain(issued.refreshToken)
  })
})
