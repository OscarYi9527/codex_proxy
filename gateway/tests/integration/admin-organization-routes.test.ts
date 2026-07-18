import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('organization administration routes (T060/T065/T067)', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  let refreshToken: string
  let deviceSessionId: string
  let adminId: string

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
        email: 'admin@example.test'
      }
    })
    accessToken = changed.json().accessToken
    refreshToken = changed.json().refreshToken
    deviceSessionId = changed.json().deviceSessionId
    adminId = (await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('role', '=', 'level1')
      .executeTakeFirstOrThrow()).id
  })

  afterEach(async () => fixture.gateway.close())

  const headers = () => ({ authorization: `Bearer ${accessToken}` })

  async function createOrganization(name: string): Promise<string> {
    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/organizations',
      headers: headers(),
      payload: { name }
    })
    expect(response.statusCode).toBe(200)
    return response.json().id
  }

  it('creates, lists and revokes an invitation while never returning its code from list APIs', async () => {
    const organizationId = await createOrganization('Organization A')
    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: headers(),
      payload: {
        organizationId,
        expiresAt: new Date(fixture.clock.nowMs() + 60_000).toISOString(),
        maxUses: 3
      }
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().code).toEqual(expect.any(String))

    const listed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/invitations',
      headers: headers()
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain(created.json().code)
    const invitationId = listed.json()[0].id as string

    const revoked = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/invitations/${invitationId}/revoke`,
      headers: headers()
    })
    expect(revoked.statusCode).toBe(204)
    const repeated = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/invitations/${invitationId}/revoke`,
      headers: headers()
    })
    expect(repeated.statusCode).toBe(409)
    expect(repeated.json().error.code).toBe('invitation_not_active')
  })

  it('protects the final active Level-1 account transactionally', async () => {
    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${adminId}/disable`,
      headers: headers()
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('last_level1_protected')
    const account = await fixture.database.db
      .selectFrom('accounts')
      .select('status')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow()
    expect(account.status).toBe('active')

    const organizationId = await createOrganization('Last Level-1 Protection')
    const demotion = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/accounts/${adminId}/role`,
      headers: headers(),
      payload: { role: 'user', organizationId }
    })
    expect(demotion.statusCode).toBe(409)
    expect(demotion.json().error.code).toBe('last_level1_protected')
  })

  it('lets Level 1 appoint a scoped Level-2 administrator', async () => {
    const organizationId = await createOrganization('Managed Organization')
    await fixture.database.db.insertInto('accounts').values({
      id: 'acct_promoted_manager',
      login_name: null,
      email: 'promoted@example.test',
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

    const promoted = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/accounts/acct_promoted_manager/role',
      headers: headers(),
      payload: { role: 'level2', organizationId }
    })
    expect(promoted.statusCode).toBe(200)
    expect(promoted.json()).toMatchObject({
      id: 'acct_promoted_manager',
      role: 'level2',
      organizationId,
      version: 2
    })
  })

  it('scopes Level-2 list and mutation APIs to its own organization', async () => {
    const organizationA = await createOrganization('Organization A')
    const organizationB = await createOrganization('Organization B')
    await fixture.database.db.insertInto('accounts').values({
      id: 'acct_org_b_user',
      login_name: null,
      email: 'other@example.test',
      role: 'user',
      organization_id: organizationB,
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
    await fixture.database.db
      .updateTable('accounts')
      .set({ role: 'level2', organization_id: organizationA })
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

    const organizations = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/organizations',
      headers: headers()
    })
    expect(organizations.json()).toEqual([
      expect.objectContaining({ id: organizationA })
    ])
    const accounts = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: headers()
    })
    expect(accounts.body).not.toContain('other@example.test')

    const crossOrganization = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/acct_org_b_user/disable`,
      headers: headers()
    })
    expect(crossOrganization.statusCode).toBe(403)
    const createOrganizationDenied = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/organizations',
      headers: headers(),
      payload: { name: 'Forbidden Organization' }
    })
    expect(createOrganizationDenied.statusCode).toBe(403)
    const roleChangeDenied = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/accounts/acct_org_b_user/role',
      headers: headers(),
      payload: { role: 'level2', organizationId: organizationB }
    })
    expect(roleChangeDenied.statusCode).toBe(403)

    const invitation = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: headers(),
      payload: {
        organizationId: organizationB,
        expiresAt: new Date(fixture.clock.nowMs() + 60_000).toISOString(),
        maxUses: 1
      }
    })
    expect(invitation.statusCode).toBe(200)
    expect(invitation.json().organizationId).toBe(organizationA)
  })
})
