import {
  beginAuthorization,
  createRealGatewayFixture,
  loginAndExchange,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('password lifecycle (T091/T094/T096)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('returns a Level 1 one-time temporary password and invalidates the old credential', async () => {
    const initial = await loginBootstrapAndExchange(fixture)
    const me = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { authorization: `Bearer ${initial.accessToken}` }
    })
    const accountId = me.json().account.id as string

    const reset = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${accountId}/temporary-password`,
      headers: { authorization: `Bearer ${initial.accessToken}` },
      payload: {}
    })
    expect(reset.statusCode).toBe(200)
    expect(reset.headers['cache-control']).toContain('no-store')
    const temporary = reset.json() as {
      temporaryPassword: string
      mustChangePassword: boolean
      expiresAt: string
    }
    expect(temporary).toMatchObject({ mustChangePassword: true })
    expect(temporary.temporaryPassword).toMatch(/^Aa9-/)
    expect(Date.parse(temporary.expiresAt)).toBeGreaterThan(fixture.clock.nowMs())
    const credential = await fixture.database.db
      .selectFrom('password_credentials')
      .select(['kind', 'password_hash'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow()
    expect(credential.kind).toBe('temporary')
    expect(credential.password_hash).not.toContain(fixture.bootstrap.password)

    const oldAuthorization = await beginAuthorization(fixture)
    const oldLogin = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize/login',
      payload: {
        authorizationTransactionId: oldAuthorization.transactionId,
        identifier: fixture.bootstrap.loginName,
        password: fixture.bootstrap.password
      }
    })
    expect(oldLogin.statusCode).toBe(303)
    expect(new URL(oldLogin.headers.location as string).searchParams.get('error')).toBe('access_denied')

    const temporarySession = await loginAndExchange(fixture, {
      identifier: fixture.bootstrap.loginName,
      password: temporary.temporaryPassword
    })
    const status = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/status',
      headers: { authorization: `Bearer ${temporarySession.accessToken}` }
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().state).toBe('password_change_required')

    await expect(loginAndExchange(fixture, {
      identifier: fixture.bootstrap.loginName,
      password: temporary.temporaryPassword
    })).rejects.toThrow('Authorization code is missing')

    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${temporarySession.accessToken}` },
      payload: {
        currentPassword: temporary.temporaryPassword,
        newPassword: 'ReplacementPassword123',
        email: 'admin@example.com'
      }
    })
    expect(changed.statusCode).toBe(200)

    const newLogin = await loginAndExchange(fixture, {
      identifier: fixture.bootstrap.loginName,
      password: 'ReplacementPassword123'
    })
    expect(newLogin.deviceSessionId).toBeTruthy()
  })
})
