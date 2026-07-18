import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('role-filtered credit administration routes (T072/T080)', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  let refreshToken: string
  let deviceSessionId: string
  let adminId: string
  let organizationId: string

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
        email: 'credit-admin@example.test'
      }
    })
    accessToken = changed.json().accessToken
    refreshToken = changed.json().refreshToken
    deviceSessionId = changed.json().deviceSessionId
    adminId = (await fixture.database.db.selectFrom('accounts')
      .select('id')
      .where('role', '=', 'level1')
      .executeTakeFirstOrThrow()).id
    const organization = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/organizations',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Credit route organization' }
    })
    organizationId = organization.json().id
    await fixture.database.db.insertInto('accounts').values({
      id: 'acct_credit_route_user',
      login_name: null,
      email: 'credit-user@example.test',
      role: 'user',
      organization_id: organizationId,
      status: 'active',
      expires_at: null,
      must_change_password: 0,
      must_provide_email: 0,
      created_at: fixture.clock.now().toISOString(),
      updated_at: fixture.clock.now().toISOString(),
      disabled_at: null,
      disabled_by: null,
      version: 1
    }).execute()
  })

  afterEach(async () => fixture.gateway.close())

  it('allows Level 1 to set totals and returns hidden policy fields', async () => {
    const headers = { authorization: `Bearer ${accessToken}` }
    const monthly = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${organizationId}/monthly-credits`,
      headers,
      payload: { allocatedCredits: '1000' }
    })
    expect(monthly.statusCode).toBe(200)
    const allocation = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/accounts/acct_credit_route_user/credit-allocation',
      headers,
      payload: { allocatedCredits: '400' }
    })
    expect(allocation.statusCode).toBe(204)
    const risk = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${organizationId}/risk-policy`,
      headers,
      payload: {
        maxOverdraftPerTurn: '50',
        maxCumulativeRisk: '200'
      }
    })
    expect(risk.statusCode).toBe(204)

    const current = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/organizations/${organizationId}/credit-periods/current`,
      headers
    })
    expect(current.statusCode).toBe(200)
    expect(current.json()).toMatchObject({
      period: {
        allocated: '1000.000000',
        settled: '0.000000',
        available: '1000.000000'
      },
      users: expect.arrayContaining([
        expect.objectContaining({
          accountId: 'acct_credit_route_user',
          allocated: '400.000000',
          available: '400.000000'
        })
      ]),
      riskPolicy: {
        maxOverdraftPerTurn: '50.000000',
        maxCumulativeRisk: '200.000000',
        activeRiskCredits: '0.000000'
      },
      modelRates: []
    })
  })

  it('omits hidden rate and risk fields from a Level-2 response', async () => {
    await fixture.database.db.updateTable('accounts')
      .set({
        role: 'level2',
        organization_id: organizationId,
        version: 2
      })
      .where('id', '=', adminId)
      .execute()
    const refreshed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'refresh_token',
        clientId: 'ai-editor-edge',
        refreshToken,
        deviceSessionId
      }
    })
    expect(refreshed.statusCode).toBe(200)
    accessToken = refreshed.json().accessToken

    const current = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/organizations/${organizationId}/credit-periods/current`,
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(current.statusCode).toBe(200)
    expect(current.json()).not.toHaveProperty('riskPolicy')
    expect(current.json()).not.toHaveProperty('modelRates')
    expect(current.body).not.toMatch(/overdraft|multiplier|activeRisk/i)
  })
})
