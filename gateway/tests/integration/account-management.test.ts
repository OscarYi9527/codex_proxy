import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('real account and device management', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  let deviceSessionId: string

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
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
    accessToken = changed.json().accessToken
    deviceSessionId = changed.json().deviceSessionId
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('returns safe status, account details and current device metadata', async () => {
    const headers = { authorization: `Bearer ${accessToken}` }
    const status = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/status',
      headers
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      state: 'ready',
      safeSummary: {
        accountDisplay: 'admin@example.com',
        availableCredits: '0.000000'
      },
      actions: []
    })

    const me = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({
      account: {
        email: 'admin@example.com',
        role: 'level1',
        organization: null,
        mustChangePassword: false,
        mustProvideEmail: false
      },
      credits: { available: '0.000000' }
    })

    const devices = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/devices',
      headers
    })
    expect(devices.statusCode).toBe(200)
    expect(devices.json()).toEqual([
      expect.objectContaining({
        id: deviceSessionId,
        current: true,
        platform: 'windows'
      })
    ])
  })

  it('rejects invalid password changes without mutating the active credential', async () => {
    const headers = { authorization: `Bearer ${accessToken}` }
    const wrong = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers,
      payload: {
        currentPassword: 'WrongPassword123',
        newPassword: 'AnotherPassword123'
      }
    })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json().error.code).toBe('invalid_credentials')

    const invalidEmail = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers,
      payload: {
        currentPassword: 'PermanentPassword123',
        newPassword: 'AnotherPassword123',
        email: 'not-an-email'
      }
    })
    expect(invalidEmail.statusCode).toBe(400)
    expect(invalidEmail.json().error.code).toBe('email_invalid')

    const weak = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers,
      payload: {
        currentPassword: 'PermanentPassword123',
        newPassword: 'weak'
      }
    })
    expect(weak.statusCode).toBe(400)
    expect(weak.json().error.code).toBe('password_policy_failed')
  })

  it('requires confirmation for current-device revocation and rejects foreign sessions', async () => {
    const headers = { authorization: `Bearer ${accessToken}` }
    const unconfirmed = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/api/v1/account/devices/${deviceSessionId}`,
      headers
    })
    expect(unconfirmed.statusCode).toBe(400)
    expect(unconfirmed.json().error.code).toBe('current_device_confirmation_required')

    const missing = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: '/api/v1/account/devices/ds_not_owned?confirmCurrent=true',
      headers
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('device_not_found')

    const revoked = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/api/v1/account/devices/${deviceSessionId}?confirmCurrent=true`,
      headers
    })
    expect(revoked.statusCode).toBe(204)
    const after = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers
    })
    expect(after.statusCode).toBe(401)
  })

  it('revokes only the current device on logout', async () => {
    const headers = { authorization: `Bearer ${accessToken}` }
    const logout = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/logout',
      headers,
      payload: {}
    })
    expect(logout.statusCode).toBe(204)
    const after = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/status',
      headers
    })
    expect(after.statusCode).toBe(401)
  })

  it('returns a safe unavailable status after the account is disabled', async () => {
    await fixture.database.db
      .updateTable('accounts')
      .set({ status: 'disabled' })
      .execute()
    const status = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/status',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      state: 'account_unavailable',
      actions: ['openAccount']
    })
    const models = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(models.statusCode).toBe(403)
    expect(models.json().error.code).toBe('account_disabled')
  })

  it('returns stable request errors for malformed and unsupported token requests', async () => {
    const malformed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: []
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe('invalid_request')

    const unsupported = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grantType: 'password' }
    })
    expect(unsupported.statusCode).toBe(400)
    expect(unsupported.json().error.code).toBe('unsupported_grant_type')
  })
})
