import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('one-time Webview ticket and HttpOnly management session (T049/T052)', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  const origin = 'http://127.0.0.1:47920'

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
    accessToken = changed.json().accessToken
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  async function ticket(): Promise<string> {
    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/webview-ticket',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        audience: origin,
        purpose: 'account-management'
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().expiresIn).toBe(60)
    return response.json().ticket
  }

  it('consumes a ticket once and creates a role-scoped HttpOnly session', async () => {
    const rawTicket = await ticket()
    const stored = await fixture.database.db
      .selectFrom('webview_tickets')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(stored.ticket_digest).not.toBe(rawTicket)
    expect(JSON.stringify(stored)).not.toContain(rawTicket)

    const missingOrigin = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      payload: { ticket: rawTicket }
    })
    expect(missingOrigin.statusCode).toBe(403)
    expect(missingOrigin.json().error.code).toBe('invalid_management_origin')

    const exchanged = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin },
      payload: { ticket: rawTicket }
    })
    expect(exchanged.statusCode).toBe(200)
    expect(exchanged.json()).toMatchObject({
      expiresIn: 1800,
      account: { role: 'level1' },
      navigation: expect.arrayContaining([
        { id: 'account', label: '我的账号' },
          { id: 'providers', label: '订阅账号' },
        { id: 'diagnostics', label: '系统诊断' }
      ])
    })
    expect(exchanged.body).not.toContain(rawTicket)
    const setCookie = exchanged.headers['set-cookie'] as string
    expect(setCookie).toMatch(/^ai_editor_management_session=/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).not.toContain('Secure')
    const cookie = setCookie.split(';', 1)[0] as string

    const me = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { cookie }
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().account.email).toBe('admin@example.com')

    const devices = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/devices',
      headers: { cookie }
    })
    expect(devices.statusCode).toBe(200)
    expect(devices.json()).toHaveLength(1)

    const usage = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/accounts/${exchanged.json().account.id}/usage`,
      headers: { cookie }
    })
    expect(usage.statusCode).toBe(200)
    expect(usage.json()).toEqual({
      summary: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        settledCredits: '0.000000'
      },
      records: []
    })

    const replay = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin },
      payload: { ticket: rawTicket }
    })
    expect(replay.statusCode).toBe(400)
    expect(replay.json().error.code).toBe('webview_ticket_invalid')

    const wrongOriginDelete = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: '/api/v1/webview/session',
      headers: { cookie, origin: 'https://evil.example' }
    })
    expect(wrongOriginDelete.statusCode).toBe(403)

    const revoked = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: '/api/v1/webview/session',
      headers: { cookie, origin }
    })
    expect(revoked.statusCode).toBe(204)
    expect(revoked.headers['set-cookie']).toContain('Max-Age=0')

    const after = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { cookie }
    })
    expect(after.statusCode).toBe(401)
  })

  it('rejects expired tickets and management sessions', async () => {
    const expiredTicket = await ticket()
    fixture.clock.advance(60_001)
    const rejected = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin },
      payload: { ticket: expiredTicket }
    })
    expect(rejected.statusCode).toBe(400)

    const freshTicket = await ticket()
    const exchanged = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin },
      payload: { ticket: freshTicket }
    })
    const cookie = String(exchanged.headers['set-cookie']).split(';', 1)[0] as string
    fixture.clock.advance(30 * 60_000 + 1)
    const expired = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: { cookie }
    })
    expect(expired.statusCode).toBe(401)
    expect(expired.json().error.code).toBe('login_required')
  })

  it('never accepts a management cookie for a different account usage route', async () => {
    const rawTicket = await ticket()
    const exchanged = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin },
      payload: { ticket: rawTicket }
    })
    const cookie = String(exchanged.headers['set-cookie']).split(';', 1)[0] as string
    const denied = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts/acct_other/usage',
      headers: { cookie }
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('forbidden')
  })
})
