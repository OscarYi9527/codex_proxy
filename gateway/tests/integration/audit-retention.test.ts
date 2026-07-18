import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('conversation audit, scope and retention (T101/T103-T107)', () => {
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

  async function insertConversation(options: {
    id: string
    organizationId: string
    accountId: string
    createdAt?: string
  }): Promise<void> {
    const createdAt = options.createdAt || fixture.clock.now().toISOString()
    await fixture.database.db.insertInto('conversation_audits').values({
      id: options.id,
      turn_id: `turn_${options.id}`,
      account_id: options.accountId,
      organization_id: options.organizationId,
      model_id: 'gpt-audit-test',
      user_text_sanitized: 'sanitized user text',
      assistant_text_sanitized: 'sanitized assistant text',
      input_tokens: 12,
      output_tokens: 8,
      created_at: createdAt,
      body_expires_at: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
      body_deleted_at: null,
      redaction_version: 1
    }).execute()
  }

  async function insertUser(id: string, organizationId: string): Promise<void> {
    await fixture.database.db.insertInto('accounts').values({
      id,
      login_name: null,
      email: `${id}@example.test`,
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
  }

  it('scopes Level-2 queries and audits allowed and denied body views', async () => {
    const organizationA = await createOrganization('Audit Organization A')
    const organizationB = await createOrganization('Audit Organization B')
    await insertUser('acct_audit_a', organizationA)
    await insertUser('acct_audit_b', organizationB)
    await insertConversation({
      id: 'audit_org_a',
      organizationId: organizationA,
      accountId: 'acct_audit_a'
    })
    await insertConversation({
      id: 'audit_org_b',
      organizationId: organizationB,
      accountId: 'acct_audit_b'
    })

    await fixture.database.db.updateTable('accounts')
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
    accessToken = refreshed.json().accessToken

    const list = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit/conversations',
      headers: headers()
    })
    expect(list.statusCode).toBe(200)
    expect(list.body).toContain('audit_org_a')
    expect(list.body).not.toContain('audit_org_b')
    expect(list.body).not.toContain('sanitized user text')

    const allowed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit/conversations/audit_org_a',
      headers: headers()
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toMatchObject({
      id: 'audit_org_a',
      userText: 'sanitized user text',
      assistantText: 'sanitized assistant text',
      bodyDeletedAt: null
    })

    const denied = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit/conversations/audit_org_b',
      headers: headers()
    })
    expect(denied.statusCode).toBe(403)
    const events = await fixture.database.db
      .selectFrom('admin_audit_events')
      .select(['action', 'outcome', 'actor_role', 'error_code'])
      .where('actor_account_id', '=', adminId)
      .where('action', '=', 'audit.conversation.view')
      .orderBy('created_at', 'asc')
      .execute()
    expect(events).toEqual([
      {
        action: 'audit.conversation.view',
        outcome: 'allowed',
        actor_role: 'level2',
        error_code: null
      },
      {
        action: 'audit.conversation.view',
        outcome: 'denied',
        actor_role: 'level2',
        error_code: 'forbidden'
      }
    ])
  })

  it('applies 7-180 day retention, deletes only bodies and preserves usage metadata', async () => {
    const organizationId = await createOrganization('Retention Organization')
    await insertUser('acct_retention', organizationId)
    await insertConversation({
      id: 'audit_retention',
      organizationId,
      accountId: 'acct_retention',
      createdAt: fixture.clock.now().toISOString()
    })

    const invalid = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${organizationId}/audit-retention`,
      headers: headers(),
      payload: { days: 181 }
    })
    expect(invalid.statusCode).toBe(400)

    const updated = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/organizations/${organizationId}/audit-retention`,
      headers: headers(),
      payload: { days: 7 }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({ organizationId, days: 7 })

    fixture.clock.advance(8 * 86_400_000)
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
    const list = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit/conversations?organizationId=${organizationId}`,
      headers: headers()
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().conversations[0]).toMatchObject({
      id: 'audit_retention',
      bodyDeletedAt: expect.any(String)
    })
    const row = await fixture.database.db
      .selectFrom('conversation_audits')
      .selectAll()
      .where('id', '=', 'audit_retention')
      .executeTakeFirstOrThrow()
    expect(row.user_text_sanitized).toBeNull()
    expect(row.assistant_text_sanitized).toBeNull()
    expect(row.input_tokens).toBe(12)
    expect(row.output_tokens).toBe(8)
  })
})
