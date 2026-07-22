import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'
import type {
  GatewayProviderRuntimeConfiguration,
  ProviderRouteAdapter
} from '../../src/routing/standalone-route-adapter.js'
import type { ChatgptLoginCoordinator } from '../../src/providers/chatgpt-login-service.js'

describe('shared TORVYE full management console', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  let cookie: string
  let runtime: GatewayProviderRuntimeConfiguration | undefined
  let refreshedAccounts: string[]
  const origin = 'http://127.0.0.1:47920'

  beforeEach(async () => {
    runtime = undefined
    refreshedAccounts = []
    const providerAdapter: ProviderRouteAdapter = {
      async listModels() {
        return {
          object: 'list',
          data: [{ id: 'real-test-model', object: 'model', owned_by: 'test' }]
        }
      },
      async forwardResponses() {
        throw new Error('Not used')
      },
      async configureProviders(value) {
        runtime = value
      },
      async safeDiagnostics() {
        return {
          providers: {
            providers: {
              'chatgpt-sub': {
                state: 'healthy',
                last_checked_at: '2026-07-17T01:00:00.000Z',
                last_status: 200,
                last_latency_ms: 321,
                windows: {
                  '1h': {
                    requests: 3,
                    success_rate: 100,
                    p95_latency_ms: 400
                  }
                }
              }
            }
          },
          circuits: {
            'chatgpt-sub': { state: 'closed' }
          },
          recentRouteErrors: []
        }
      },
      async safeAccountPool() {
        const account = runtime?.chatgptAccounts[0] as
          Record<string, unknown> | undefined
        return {
          strategy: runtime?.chatgptAccountStrategy || 'headroom',
          accounts: account ? [{
            id: String(account['id']),
            label: String(account['label'] || 'Central account'),
            accountIdPreview: 'acct…test',
            planType: 'plus',
            status: 'active',
            routingEnabled: account['routing_enabled'] !== false,
            routingWeight: Number(account['routing_weight']) || 1,
            lowQuotaThreshold: Number(account['low_quota_threshold']) || 10,
            dailyRequestLimit: Number(account['daily_request_limit']) || 0,
            dailyTokenLimit: Number(account['daily_token_limit']) || 0,
            reservedModels: Array.isArray(account['reserved_models'])
              ? account['reserved_models'] as string[]
              : [],
            quota: {
              source: 'provider',
              primary: {
                usedPercent: 20,
                remainingPercent: 80,
                resetsAt: 1_800_000_000,
                windowMinutes: 300
              },
              secondary: null,
              updatedAt: '2026-07-17T01:00:00.000Z',
              syncStatus: 'synced',
              syncError: null
            },
            runtime: {
              activeRequests: 1,
              concurrencyLimit: 3,
              cooldownUntil: null,
              modelCooldowns: 0
            },
            health: {
              requests: 3,
              successRate: 100,
              p95LatencyMs: 400,
              rateLimited: 0,
              lastRequestAt: '2026-07-17T01:00:00.000Z',
              lastErrorType: null,
              lastErrorMessage: null
            }
          }] : [],
          queueDepth: account ? 1 : 0,
          recentRouteDecisions: account ? [{
            at: '2026-07-17T01:00:00.000Z',
            model: 'gpt-5.4-mini',
            selectedAccountId: String(account['id']),
            selectedAccountLabel: String(account['label'] || 'Central account'),
            outcome: 'selected',
            queueWaitMs: 0,
            accounts: []
          }] : []
        }
      },
      async refreshChatgptAccountUsage(accountId) {
        refreshedAccounts.push(accountId)
      },
      async probeProvider() {
        return {
          ok: true,
          status: 200,
          latency: 17,
          source: 'test-active-probe',
          error: null
        }
      }
    }
    const chatgptLogin: ChatgptLoginCoordinator = {
      async start(providerId) {
        return {
          id: `login_${providerId}`,
          status: 'waiting',
          verificationUrl: 'https://auth.openai.com/authorize'
        }
      },
      status() {
        return {
          status: 'waiting',
          verificationUrl: 'https://auth.openai.com/authorize'
        }
      },
      async close() {}
    }
    fixture = await createRealGatewayFixture({
      providerAdapter,
      chatgptLogin
    })
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

    const ticket = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/webview-ticket',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        audience: origin,
        purpose: 'account-management'
      }
    })
    const session = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/webview/session',
      headers: { origin },
      payload: { ticket: ticket.json().ticket }
    })
    cookie = String(session.headers['set-cookie']).split(';', 1)[0] as string
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('serves the exact shared standalone console behind the browser surface', async () => {
    const [embedded, full, runtime, script] = await Promise.all([
      fixture.gateway.app.inject({ method: 'GET', url: '/admin' }),
      fixture.gateway.app.inject({ method: 'GET', url: '/admin/full' }),
      fixture.gateway.app.inject({ method: 'GET', url: '/admin/runtime.js' }),
      fixture.gateway.app.inject({ method: 'GET', url: '/admin/app.js' })
    ])

    expect(embedded.statusCode).toBe(200)
    expect(embedded.body).toContain('<div id="root"></div>')
    expect(full.statusCode).toBe(200)
    expect(full.body).toContain('TORVYE AI Gateway')
    expect(full.body).toContain('统一管理平台')
    expect(full.body).toContain('/admin/runtime.js')
    expect(full.body).toContain('/admin/app.js')
    expect(full.body).toContain('data-admin-onclick=')
    expect(full.body).not.toMatch(/\s(?:onclick|onchange|oninput|onkeydown)=/)
    expect(runtime.body).toContain('mode:"gateway"')
    expect(script.body).toContain('bootstrapCentralManagement')
    expect(script.body).toContain('dispatchAdminAction')
    expect(script.body).not.toMatch(/\s(?:onclick|onchange|oninput|onkeydown)=/)
    expect(script.body).toContain('浏览器完整管理平台仅对一级管理员开放')
    expect(script.body).not.toContain('localStorage.setItem("accessToken"')

    for (const response of [embedded, runtime, script]) {
      expect(response.headers['content-security-policy']).toContain("default-src 'self'")
      expect(response.headers['content-security-policy']).not.toContain(
        "script-src 'self' 'unsafe-inline'"
      )
      expect(response.headers['referrer-policy']).toBe('no-referrer')
    }
    expect(full.headers['content-security-policy']).toContain(
      "style-src 'self' 'unsafe-inline'"
    )
    expect(full.headers['content-security-policy']).toContain("script-src 'self'")
    expect(full.headers['content-security-policy']).not.toContain(
      "script-src 'self' 'unsafe-inline'"
    )
    expect(full.headers['referrer-policy']).toBe('no-referrer')
  })

  it('requires a Level-1 management session for every compatibility API', async () => {
    const denied = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/config'
    })
    expect(denied.statusCode).toBe(401)

    const session = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/session',
      headers: { cookie }
    })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toEqual({
      account: {
        id: expect.any(String),
        role: 'level1'
      }
    })

    await fixture.database.db
      .updateTable('accounts')
      .set({ role: 'level2' })
      .execute()
    const roleDenied = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/config',
      headers: { cookie }
    })
    expect(roleDenied.statusCode).toBe(403)
    expect(roleDenied.json().error.message).toContain('一级管理员')
  })

  it('adapts central Providers, routes and masked credentials to the full console', async () => {
    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        kind: 'relay',
        displayName: 'Central Relay',
        config: {
          baseUrl: 'https://relay.example.test/v1',
          models: ['gpt-central-test']
        }
      }
    })
    const providerId = created.json().id as string
    const secret = 'sk-central-console-secret-abcd'
    const credential = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/credentials`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { secret }
    })
    expect(credential.statusCode).toBe(200)

    const config = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/config',
      headers: { cookie }
    })
    expect(config.statusCode).toBe(200)
    expect(config.body).not.toContain(secret)
    expect(config.json()).toMatchObject({
      mode: 'gateway',
      source: 'central',
      config: {
        deploymentMode: 'gateway',
        relays: [{
          id: providerId,
          name: 'Central Relay',
          base_url: 'https://relay.example.test/v1',
          api_key: 'sk-...abcd',
          models: ['gpt-central-test']
        }]
      }
    })

    const models = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/models',
      headers: { cookie }
    })
    expect(models.statusCode).toBe(200)
    expect(models.json().data).toEqual([
      expect.objectContaining({
        id: `relay-${providerId}-gpt-central-test`,
        owned_by: providerId
      })
    ])

    const diagnostics = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/diagnostics',
      headers: { cookie }
    })
    expect(diagnostics.statusCode).toBe(200)
    expect(diagnostics.body).not.toContain(secret)
    expect(diagnostics.json()).toMatchObject({
      credential_protection: {
        enabled: true,
        scheme: 'envelope-v1',
        write_only: true
      },
      deployment: {
        consistency: { synchronized: true },
        can_deploy: false
      }
    })
  })

  it('persists relay changes centrally and never returns the submitted secret', async () => {
    const secret = 'sk-full-console-write-only-9876'
    const saved = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/relays',
      headers: { cookie, origin },
      payload: {
        id: 'friendly-client-id',
        name: 'Browser Relay',
        base_url: 'https://browser-relay.example.test/v1',
        api_key: secret,
        models: ['gpt-browser']
      }
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.body).not.toContain(secret)
    expect(saved.json().config.relays).toEqual([
      expect.objectContaining({
        name: 'Browser Relay',
        api_key: 'sk-...9876'
      })
    ])

    const listed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain(secret)
    expect(listed.json().providers).toEqual([
      expect.objectContaining({
        kind: 'relay',
        displayName: 'Browser Relay',
        credentials: [
          expect.objectContaining({ maskedPreview: 'sk-...9876' })
        ]
      })
    ])

    const providerId = listed.json().providers[0].id as string
    const updated = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/relays',
      headers: { cookie, origin },
      payload: {
        id: providerId,
        name: 'Browser Relay Updated',
        base_url: 'https://browser-relay.example.test/v2',
        api_key: 'sk-...9876',
        models: ['gpt-browser', 'gpt-browser-fast']
      }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().config.relays[0]).toMatchObject({
      id: providerId,
      name: 'Browser Relay Updated',
      base_url: 'https://browser-relay.example.test/v2',
      api_key: 'sk-...9876',
      models: ['gpt-browser', 'gpt-browser-fast']
    })

    const removed = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/admin/api/relays/${providerId}`,
      headers: { cookie, origin }
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().config.relays).toEqual([])
  })

  it('reports real per-model and Shanghai-day usage without fabricating zero calls', async () => {
    const saved = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/relays',
      headers: { cookie, origin },
      payload: {
        name: 'Usage Relay',
        base_url: 'https://usage-relay.example.test/v1',
        api_key: 'sk-usage-relay-secret-1234',
        models: ['gpt-usage']
      }
    })
    const providerId = saved.json().config.relays[0].id as string
    const admin = await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('role', '=', 'level1')
      .executeTakeFirstOrThrow()
    await fixture.database.db.insertInto('organizations').values({
      id: 'org_full_console_usage',
      name: 'Full Console Usage',
      status: 'active',
      billing_timezone: 'Asia/Shanghai',
      audit_retention_days: 30,
      overdraft_per_turn_override: null,
      cumulative_risk_override: null,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      version: 1
    }).execute()
    await fixture.database.db.insertInto('organization_credit_periods').values({
      id: 'period_full_console_usage',
      organization_id: 'org_full_console_usage',
      period_start: '2026-07-01T00:00:00.000Z',
      period_end: '2026-08-01T00:00:00.000Z',
      allocated_credits: '100.000000',
      settled_credits: '0.030000',
      created_at: '2026-07-01T00:00:00.000Z',
      closed_at: null,
      version: 1
    }).execute()
    for (const [index, inputTokens, outputTokens] of [
      [1, 120, 30],
      [2, 80, 20]
    ] as const) {
      await fixture.database.db.insertInto('usage_records').values({
        id: `usage_full_console_${index}`,
        turn_id: `turn_full_console_${index}`,
        account_id: admin.id,
        organization_id: 'org_full_console_usage',
        period_id: 'period_full_console_usage',
        model_id: `relay-${providerId}-gpt-usage`,
        provider_id: providerId,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        usage_source: 'upstream',
        input_credits: '0.010000',
        output_credits: '0.005000',
        total_credits: '0.015000',
        started_at: `2026-07-16T20:0${index}:00.000Z`,
        completed_at: `2026-07-16T20:0${index}:30.000Z`,
        route_error_code: null
      }).execute()
    }

    const stats = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/admin/api/stats',
      headers: { cookie, origin }
    })
    expect(stats.statusCode).toBe(200)
    expect(stats.json().providers[`relay:${providerId}`]).toMatchObject({
      requests: 2,
      input_tokens: 200,
      output_tokens: 50,
      models: {
        [`relay-${providerId}-gpt-usage`]: {
          requests: 2,
          input_tokens: 200,
          output_tokens: 50
        }
      }
    })
    expect(stats.json().daily['2026-07-17']).toMatchObject({
      requests: 2,
      account_attempts: 2,
      input_tokens: 200,
      output_tokens: 50,
      accounts: {
        [admin.id]: {
          requests: 2,
          successes: 2,
          failures: 0
        }
      }
    })
  })

  it('configures built-in Providers and keeps masked secrets unchanged', async () => {
    const first = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/admin/api/config',
      headers: { cookie, origin },
      payload: {
        openaiApiBaseUrl: 'https://openai.example.test/v1',
        openaiApiKey: 'sk-openai-central-secret-1111',
        upstreamUrl: 'https://deepseek.example.test/anthropic/v1/messages',
        deepseekApiKey: 'sk-deepseek-central-secret-2222'
      }
    })
    expect(first.statusCode).toBe(200)
    expect(first.body).not.toContain('sk-openai-central-secret-1111')
    expect(first.body).not.toContain('sk-deepseek-central-secret-2222')
    expect(first.json().config).toMatchObject({
      openaiApiBaseUrl: 'https://openai.example.test/v1',
      openaiApiKey: 'sk-...1111',
      upstreamUrl: 'https://deepseek.example.test/anthropic/v1/messages',
      deepseekApiKey: 'sk-...2222'
    })

    const second = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/admin/api/config',
      headers: { cookie, origin },
      payload: {
        openaiApiBaseUrl: 'https://openai.example.test/v2',
        openaiApiKey: 'sk-...1111',
        upstreamUrl: 'https://deepseek.example.test/anthropic/v2/messages',
        deepseekApiKey: 'sk-...2222'
      }
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().config).toMatchObject({
      openaiApiBaseUrl: 'https://openai.example.test/v2',
      openaiApiKey: 'sk-...1111',
      upstreamUrl: 'https://deepseek.example.test/anthropic/v2/messages',
      deepseekApiKey: 'sk-...2222'
    })
    expect(runtime).toMatchObject({
      openaiApiKey: 'sk-openai-central-secret-1111',
      deepseekApiKey: 'sk-deepseek-central-secret-2222'
    })
  })

  it('supports central subscription account import, routing and quota refresh', async () => {
    const authJson = JSON.stringify({
      tokens: {
        access_token: 'access-token-not-returned',
        refresh_token: 'refresh-token-not-returned',
        account_id: 'acct-central-test'
      }
    })
    const imported = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/chatgpt-accounts/import',
      headers: { cookie, origin },
      payload: {
        content: authJson,
        label: 'Central Test',
        routingEnabled: true
      }
    })
    expect(imported.statusCode).toBe(200)
    expect(imported.body).not.toContain('access-token-not-returned')
    expect(imported.body).not.toContain('refresh-token-not-returned')
    const credentialId = imported.json().credentialId as string
    expect(imported.json().config.chatgptAccounts[0]).toMatchObject({
      id: credentialId,
      label: 'Central Test',
      routing_enabled: true,
      usage: {
        primary: {
          used_percent: 20,
          remaining_percent: 80
        }
      }
    })

    const renamed = await fixture.gateway.app.inject({
      method: 'PATCH',
      url: `/admin/api/chatgpt-accounts/${credentialId}/rename`,
      headers: { cookie, origin },
      payload: { label: 'Renamed Central Account' }
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().config.chatgptAccounts[0].label)
      .toBe('Renamed Central Account')

    const routed = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/admin/api/chatgpt-accounts/${credentialId}/routing`,
      headers: { cookie, origin },
      payload: {
        enabled: false,
        weight: 8,
        low_quota_threshold: 15,
        daily_request_limit: 20,
        daily_token_limit: 30_000,
        reserved_models: ['gpt-5.4-mini']
      }
    })
    expect(routed.statusCode).toBe(200)
    expect(routed.json().config.chatgptAccounts[0]).toMatchObject({
      routing_enabled: false,
      routing_weight: 8,
      low_quota_threshold: 15,
      daily_request_limit: 20,
      daily_token_limit: 30_000,
      reserved_models: ['gpt-5.4-mini']
    })

    const refreshed = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/admin/api/chatgpt-accounts/${credentialId}/refresh-usage`,
      headers: { cookie, origin },
      payload: {}
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshedAccounts).toContain(credentialId)

    const refreshedAll = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/chatgpt-accounts/refresh-usage-all',
      headers: { cookie, origin },
      payload: {}
    })
    expect(refreshedAll.statusCode).toBe(200)
    expect(refreshedAll.json().result.errors).toEqual([])

    const strategy = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/admin/api/config',
      headers: { cookie, origin },
      payload: { chatgptAccountStrategy: 'weighted' }
    })
    expect(strategy.statusCode).toBe(200)
    expect(strategy.json().config.chatgptAccountStrategy).toBe('weighted')

    const checked = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/chatgpt-accounts/check-all',
      headers: { cookie, origin },
      payload: {}
    })
    expect(checked.statusCode).toBe(200)

    const reordered = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/chatgpt-accounts/reorder',
      headers: { cookie, origin },
      payload: { accountIds: [credentialId] }
    })
    expect(reordered.statusCode).toBe(409)

    const removed = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/admin/api/chatgpt-accounts/${credentialId}`,
      headers: { cookie, origin }
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().config.chatgptAccounts).toEqual([])
  })

  it('exposes central health, usage, rates and login through compatibility routes', async () => {
    const started = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/chatgpt-login/start',
      headers: { cookie, origin },
      payload: {
        label: 'Browser login',
        routingEnabled: false
      }
    })
    expect(started.statusCode).toBe(202)
    expect(started.json()).toMatchObject({
      status: 'waiting',
      verificationUrl: 'https://auth.openai.com/authorize'
    })
    const [preflight, status, cancelled] = await Promise.all([
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/chatgpt-login/preflight',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/chatgpt-login/status',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'POST',
        url: '/admin/api/chatgpt-login/cancel',
        headers: { cookie, origin },
        payload: {}
      })
    ])
    expect(preflight.json().available).toBe(true)
    expect(status.json().status).toBe('waiting')
    expect(cancelled.json().status).toBe('cancelled')

    const responses = await Promise.all([
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/stats',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/resilience',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/error-guide',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/prices',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/costs',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/runtime-info',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/diagnosis',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/config-snapshots',
        headers: { cookie }
      }),
      fixture.gateway.app.inject({
        method: 'GET',
        url: '/admin/api/account-backups',
        headers: { cookie }
      })
    ])
    for (const response of responses) expect(response.statusCode).toBe(200)
    expect(responses[0].json()).toMatchObject({ providers: {}, accounts: {} })
    expect(responses[1].json()).toEqual({
      circuits: [{ name: 'chatgpt-sub', state: 'closed' }]
    })
    expect(responses[2].json()).toEqual({ codes: [] })
    expect(responses[3].json().catalog.notice).toContain('中央 Gateway')
    expect(responses[4].json()).toMatchObject({ today_usd: 0, total_usd: 0 })
    expect(responses[5].json().runtime.version).toBe('central-gateway')
    expect(responses[6].json().summary.conclusion).toContain('中央 Gateway')
    expect(responses[7].json()).toEqual({ snapshots: [] })
    expect(responses[8].json()).toEqual({ backups: [] })

    const noProviderPing = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/ping',
      headers: { cookie, origin },
      payload: { type: 'openai-api' }
    })
    expect(noProviderPing.json()).toMatchObject({ ok: false })
    const all = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/ping-all',
      headers: { cookie, origin },
      payload: {}
    })
    expect(all.json()).toEqual({
      results: {
        'chatgpt-sub': {
          ok: true,
          status: 200,
          latency: 17,
          source: 'test-active-probe',
          error: null
        }
      },
      allOk: true
    })

    const priceWrite = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/admin/api/prices',
      headers: { cookie, origin },
      payload: { prices: {} }
    })
    expect(priceWrite.statusCode).toBe(409)
  })

  it('fails closed for standalone-only destructive operations', async () => {
    const reset = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: '/admin/api/stats',
      headers: { cookie, origin }
    })
    expect(reset.statusCode).toBe(409)
    expect(reset.json().error).toMatchObject({
      code: 'full_console_operation_unavailable'
    })

    const restart = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/admin/api/proxy/restart',
      headers: { cookie, origin },
      payload: {}
    })
    expect(restart.statusCode).toBe(409)
    expect(restart.json().error.message).toContain('standalone Proxy')

    for (const candidate of [
      { method: 'DELETE', url: '/admin/api/resilience' },
      { method: 'DELETE', url: '/admin/api/provider-health' },
      { method: 'POST', url: '/admin/api/runtime-repair' },
      { method: 'POST', url: '/admin/api/deploy-update' }
    ] as const) {
      const response = await fixture.gateway.app.inject({
        ...candidate,
        headers: { cookie, origin },
        payload: candidate.method === 'POST' ? {} : undefined
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('full_console_operation_unavailable')
    }
  })
})
