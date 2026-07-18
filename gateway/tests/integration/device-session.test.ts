import {
  createRealGatewayFixture,
  loginAndExchange,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('device session lifecycle (T092/T095)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('lists safe device metadata and revokes a selected non-current device only', async () => {
    const bootstrap = await loginBootstrapAndExchange(fixture)
    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${bootstrap.accessToken}` },
      payload: {
        currentPassword: fixture.bootstrap.password,
        newPassword: 'PermanentPassword123',
        email: 'admin@example.com'
      }
    })
    expect(changed.statusCode).toBe(200)
    const first = changed.json() as { accessToken: string; deviceSessionId: string }
    const second = await loginAndExchange(fixture, {
      identifier: fixture.bootstrap.loginName,
      password: 'PermanentPassword123',
      device: { name: 'Second Mac', platform: 'macos' }
    })

    const devices = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/devices',
      headers: { authorization: `Bearer ${first.accessToken}` }
    })
    expect(devices.statusCode).toBe(200)
    expect(devices.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: first.deviceSessionId,
        current: true,
        platform: 'windows'
      }),
      expect.objectContaining({
        id: second.deviceSessionId,
        current: false,
        platform: 'macos'
      })
    ]))
    expect(JSON.stringify(devices.json())).not.toMatch(/refresh|access.?token/i)

    const revoke = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/api/v1/account/devices/${second.deviceSessionId}`,
      headers: { authorization: `Bearer ${first.accessToken}` }
    })
    expect(revoke.statusCode).toBe(204)

    const revokedSession = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { authorization: `Bearer ${second.accessToken}` }
    })
    expect(revokedSession.statusCode).toBe(401)
    const currentSession = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { authorization: `Bearer ${first.accessToken}` }
    })
    expect(currentSession.statusCode).toBe(200)
  })

  it('keeps only the newest active session when the same device logs in again', async () => {
    const bootstrap = await loginBootstrapAndExchange(fixture)
    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${bootstrap.accessToken}` },
      payload: {
        currentPassword: fixture.bootstrap.password,
        newPassword: 'PermanentPassword123',
        email: 'admin@example.com'
      }
    })
    expect(changed.statusCode).toBe(200)
    const first = changed.json() as { accessToken: string; deviceSessionId: string }

    const replacement = await loginAndExchange(fixture, {
      identifier: fixture.bootstrap.loginName,
      password: 'PermanentPassword123'
    })
    const devices = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/devices',
      headers: { authorization: `Bearer ${replacement.accessToken}` }
    })

    expect(devices.statusCode).toBe(200)
    expect(devices.json()).toEqual([
      expect.objectContaining({
        id: replacement.deviceSessionId,
        current: true,
        name: 'Test Windows PC',
        platform: 'windows',
        revokedAt: null
      })
    ])
    const supersededSession = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { authorization: `Bearer ${first.accessToken}` }
    })
    expect(supersededSession.statusCode).toBe(401)
  })
})
