import {
  beginAuthorization,
  createPkce,
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

interface TokenSet {
  accessToken: string
  refreshToken: string
  deviceSessionId: string
}

async function exchangeRedirect(
  fixture: RealGatewayFixture,
  redirectUri: string,
  callbackUri: string,
  deviceName: string
): Promise<TokenSet> {
  const code = new URL(redirectUri).searchParams.get('code')
  if (!code) throw new Error('Authorization code is missing')
  const { verifier } = createPkce()
  const response = await fixture.gateway.app.inject({
    method: 'POST',
    url: '/api/v1/oauth/token',
    payload: {
      grantType: 'authorization_code',
      clientId: 'ai-editor-code',
      code,
      codeVerifier: verifier,
      redirectUri: callbackUri,
      device: { name: deviceName, platform: 'windows' }
    }
  })
  if (response.statusCode !== 200) throw new Error(response.body)
  return response.json()
}

async function registerAccount(
  fixture: RealGatewayFixture,
  options: {
    invitationCode: string
    email: string
    password: string
  }
): Promise<TokenSet> {
  const authorization = await beginAuthorization(fixture)
  const response = await fixture.gateway.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      authorizationTransactionId: authorization.transactionId,
      ...options
    }
  })
  if (response.statusCode !== 200) throw new Error(response.body)
  return exchangeRedirect(
    fixture,
    response.json().redirectUri,
    authorization.redirectUri,
    options.email
  )
}

async function loginAccount(
  fixture: RealGatewayFixture,
  email: string,
  password: string
): Promise<TokenSet> {
  const authorization = await beginAuthorization(fixture)
  const response = await fixture.gateway.app.inject({
    method: 'POST',
    url: '/api/v1/oauth/authorize/login',
    payload: {
      authorizationTransactionId: authorization.transactionId,
      identifier: email,
      password
    }
  })
  if (response.statusCode !== 303) throw new Error(response.body)
  return exchangeRedirect(
    fixture,
    response.headers.location as string,
    authorization.redirectUri,
    email
  )
}

describe('role and organization authorization (T060)', () => {
  let fixture: RealGatewayFixture
  let level1Token: string

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
    const bootstrapTokens = await loginBootstrapAndExchange(fixture)
    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${bootstrapTokens.accessToken}` },
      payload: {
        currentPassword: fixture.bootstrap.password,
        newPassword: 'PermanentPassword123',
        email: 'admin@example.com'
      }
    })
    level1Token = changed.json().accessToken
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  const headers = (token: string) => ({
    authorization: `Bearer ${token}`
  })

  async function createOrganization(name: string): Promise<string> {
    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/organizations',
      headers: headers(level1Token),
      payload: { name }
    })
    expect(response.statusCode).toBe(201)
    return response.json().id
  }

  async function createInvitation(
    organizationId: string,
    token = level1Token
  ): Promise<string> {
    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: headers(token),
      payload: {
        organizationId,
        expiresAt: '2026-07-18T00:00:00.000Z',
        maxUses: 5
      }
    })
    expect(response.statusCode).toBe(201)
    return response.json().code
  }

  it('isolates Level-2 users, rejects ordinary users, and audits denied access', async () => {
    const organizationA = await createOrganization('Organization A')
    const organizationB = await createOrganization('Organization B')
    const level2Password = 'LevelTwoPassword123'
    const userPassword = 'OrdinaryPassword123'
    const level2Initial = await registerAccount(fixture, {
      invitationCode: await createInvitation(organizationA),
      email: 'level2@example.com',
      password: level2Password
    })
    const userA = await registerAccount(fixture, {
      invitationCode: await createInvitation(organizationA),
      email: 'user-a@example.com',
      password: userPassword
    })
    const userB = await registerAccount(fixture, {
      invitationCode: await createInvitation(organizationB),
      email: 'user-b@example.com',
      password: userPassword
    })
    const accountRows = await fixture.database.db
      .selectFrom('accounts')
      .select(['id', 'email'])
      .where('email', 'in', [
        'level2@example.com',
        'user-a@example.com',
        'user-b@example.com'
      ])
      .execute()
    const accountId = (email: string) => {
      const id = accountRows.find(row => row.email === email)?.id
      if (!id) throw new Error(`Missing account ${email}`)
      return id
    }

    const ticket = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/webview-ticket',
      headers: headers(level2Initial.accessToken),
      payload: {
        audience: 'http://127.0.0.1:47920',
        purpose: 'account-management'
      }
    })
    expect(ticket.statusCode).toBe(200)
    const webview = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin: 'http://127.0.0.1:47920' },
      payload: { ticket: ticket.json().ticket }
    })
    expect(webview.statusCode).toBe(200)
    const managementCookie = String(webview.headers['set-cookie']).split(';')[0]

    const promoted = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/accounts/${accountId('level2@example.com')}/role`,
      headers: headers(level1Token),
      payload: { role: 'level2' }
    })
    expect(promoted.statusCode).toBe(200)
    expect(promoted.json().role).toBe('level2')

    const staleRoleToken = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: headers(level2Initial.accessToken)
    })
    expect(staleRoleToken.statusCode).toBe(401)
    const staleManagementSession = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: { cookie: managementCookie }
    })
    expect(staleManagementSession.statusCode).toBe(401)
    const level2 = await loginAccount(
      fixture,
      'level2@example.com',
      level2Password
    )

    const ordinaryDenied = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: headers(userA.accessToken)
    })
    expect(ordinaryDenied.statusCode).toBe(403)
    expect(ordinaryDenied.json().error.code).toBe('forbidden')

    const listed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/accounts',
      headers: headers(level2.accessToken)
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().accounts.map((account: { email: string }) => account.email))
      .toEqual(['user-a@example.com'])

    const crossOrganization = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/accounts/${accountId('user-b@example.com')}`,
      headers: headers(level2.accessToken)
    })
    expect(crossOrganization.statusCode).toBe(403)
    expect(crossOrganization.json().error.code).toBe('forbidden')

    const roleDenied = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/accounts/${accountId('user-a@example.com')}/role`,
      headers: headers(level2.accessToken),
      payload: { role: 'level2' }
    })
    expect(roleDenied.statusCode).toBe(403)

    const disabled = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${accountId('user-a@example.com')}/disable`,
      headers: headers(level2.accessToken)
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json().status).toBe('disabled')
    const staleUserToken = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: headers(userA.accessToken)
    })
    expect(staleUserToken.statusCode).toBe(401)

    const crossInvitation = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: headers(level2.accessToken),
      payload: {
        organizationId: organizationB,
        expiresAt: '2026-07-18T00:00:00.000Z',
        maxUses: 1
      }
    })
    expect(crossInvitation.statusCode).toBe(403)
    const ownInvitation = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: headers(level2.accessToken),
      payload: {
        expiresAt: '2026-07-18T00:00:00.000Z',
        maxUses: 1
      }
    })
    expect(ownInvitation.statusCode).toBe(201)
    expect(ownInvitation.json()).toMatchObject({
      organizationId: organizationA,
      maxUses: 1
    })
    expect(typeof ownInvitation.json().code).toBe('string')
    const listedInvitations = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/invitations',
      headers: headers(level2.accessToken)
    })
    expect(listedInvitations.statusCode).toBe(200)
    expect(listedInvitations.json().invitations.every(
      (invitation: { organizationId: string; code?: string }) =>
        invitation.organizationId === organizationA &&
        invitation.code === undefined
    )).toBe(true)

    const temporaryDenied = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${accountId('user-b@example.com')}/temporary-password`,
      headers: headers(level2.accessToken)
    })
    expect(temporaryDenied.statusCode).toBe(403)
    const temporary = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${accountId('user-b@example.com')}/temporary-password`,
      headers: headers(level1Token)
    })
    expect(temporary.statusCode).toBe(200)
    expect(temporary.headers['cache-control']).toContain('no-store')
    expect(temporary.json()).toMatchObject({ mustChangePassword: true })
    expect(typeof temporary.json().temporaryPassword).toBe('string')
    const credential = await fixture.database.db
      .selectFrom('password_credentials')
      .select('password_hash')
      .where('account_id', '=', accountId('user-b@example.com'))
      .executeTakeFirstOrThrow()
    expect(credential.password_hash).not.toContain(
      temporary.json().temporaryPassword
    )
    const resetUserToken = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/account/me',
      headers: headers(userB.accessToken)
    })
    expect(resetUserToken.statusCode).toBe(401)

    const deniedAudits = await fixture.database.db
      .selectFrom('admin_audit_events')
      .select(['action', 'target_id', 'outcome'])
      .where('outcome', '=', 'denied')
      .execute()
    expect(deniedAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'account.list', outcome: 'denied' }),
      expect.objectContaining({
        action: 'account.read',
        target_id: accountId('user-b@example.com'),
        outcome: 'denied'
      }),
      expect.objectContaining({
        action: 'account.role.update',
        target_id: accountId('user-a@example.com'),
        outcome: 'denied'
      }),
      expect.objectContaining({
        action: 'invitation.create',
        target_id: organizationB,
        outcome: 'denied'
      })
    ]))
    expect(userB.accessToken).toBeTruthy()
  }, 30_000)

  it('atomically protects the final effective Level-1 account', async () => {
    const organizationId = await createOrganization('Administrator Organization')
    const admin = await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('login_name', '=', 'admin')
      .executeTakeFirstOrThrow()
    const assigned = await fixture.gateway.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/accounts/${admin.id}`,
      headers: headers(level1Token),
      payload: { organizationId }
    })
    expect(assigned.statusCode).toBe(200)
    const current = await loginAccount(
      fixture,
      'admin@example.com',
      'PermanentPassword123'
    )

    for (const request of [
      {
        method: 'POST' as const,
        url: `/api/v1/admin/accounts/${admin.id}/disable`
      },
      {
        method: 'DELETE' as const,
        url: `/api/v1/admin/accounts/${admin.id}`
      },
      {
        method: 'PUT' as const,
        url: `/api/v1/admin/accounts/${admin.id}/role`,
        payload: { role: 'user' }
      }
    ]) {
      const response = await fixture.gateway.app.inject({
        ...request,
        headers: headers(current.accessToken)
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('last_level1_protected')
    }
    const unchanged = await fixture.database.db
      .selectFrom('accounts')
      .select(['role', 'status'])
      .where('id', '=', admin.id)
      .executeTakeFirstOrThrow()
    expect(unchanged).toEqual({ role: 'level1', status: 'active' })
  }, 20_000)
})
