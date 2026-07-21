import type {
  GatewayProviderRuntimeConfiguration,
  ProviderRouteAdapter
} from '../../src/routing/standalone-route-adapter.js'
import type { ChatgptLoginCoordinator } from '../../src/providers/chatgpt-login-service.js'
import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('Level-1 Provider administration (T081/T082/T084-T089)', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
	let runtime: GatewayProviderRuntimeConfiguration
	let importChatgptCredential: ((authJson: string) => Promise<void>) | undefined
	let loginProviderId: string | undefined
	let refreshedAccountId: string | undefined

  beforeEach(async () => {
    const adapter: ProviderRouteAdapter = {
      async listModels() {
        return { object: 'list', data: [] }
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
            relay_test: {
              apiKey: 'diagnostic-secret',
              url: 'https://relay.example.test/v1?api_key=diagnostic-secret'
            }
          },
          circuits: { relay_test: { state: 'closed' } },
					recentRouteErrors: []
				}
			},
			async safeAccountPool() {
				const account = runtime?.chatgptAccounts?.[0] as
					Record<string, unknown> | undefined
				return {
					strategy: runtime?.chatgptAccountStrategy || 'headroom',
					accounts: account ? [{
						id: String(account['id']),
						label: String(account['label']),
						accountIdPreview: 'chatgp…t-test',
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
							requests: 10,
							successRate: 90,
							p95LatencyMs: 900,
							rateLimited: 1,
							lastRequestAt: '2026-07-17T01:00:00.000Z',
							lastErrorType: null,
							lastErrorMessage: null
						}
					}] : [],
					queueDepth: 0,
					recentRouteDecisions: []
				}
			},
			async refreshChatgptAccountUsage(accountId) {
				refreshedAccountId = accountId
			}
		}
    const chatgptLogin: ChatgptLoginCoordinator = {
      async start(providerId, importCredential) {
        loginProviderId = providerId
        importChatgptCredential = importCredential
        return {
          id: 'oauth_test',
          status: 'waiting',
          message: 'Open the official login URL',
          startedAt: '2026-07-17T00:00:00.000Z',
          verificationUrl: 'https://auth.openai.com/authorize'
        }
      },
      status(providerId) {
        return providerId === loginProviderId
          ? {
              id: 'oauth_test',
              status: 'waiting',
              verificationUrl: 'https://auth.openai.com/authorize'
            }
          : { status: 'idle' }
      },
      async close() {}
    }
    fixture = await createRealGatewayFixture({
      providerAdapter: adapter,
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
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  const headers = () => ({ authorization: `Bearer ${accessToken}` })

  it('creates a Relay, masks its plaintext credential and applies a dynamic model route', async () => {
    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: {
        kind: 'relay',
        displayName: '隔离测试 Relay',
        config: {
          baseUrl: 'http://127.0.0.1:40123/v1',
          models: ['gpt-5.4-mini']
        }
      }
    })
    expect(created.statusCode).toBe(200)
    const providerId = created.json().id as string
    expect(created.body).not.toMatch(/secret_payload|apiKey|access_token|refresh_token/i)

    const credential = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/credentials`,
      headers: headers(),
      payload: { secret: 'sk-isolated-provider-secret-abcd' }
    })
    expect(credential.statusCode).toBe(200)
    expect(credential.json()).toMatchObject({
      maskedPreview: 'sk-...abcd',
      storageFormat: 'envelope-v1',
      keyVersion: 'test-kek-v1',
      credentialVersion: 1,
      lastUsedAt: null
    })
    expect(credential.body).not.toContain('sk-isolated-provider-secret-abcd')

    const listed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers',
      headers: headers()
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain('sk-isolated-provider-secret-abcd')
    expect(listed.json().warning).toBeNull()
    expect(listed.json().providers[0].credentials[0].maskedPreview).toBe('sk-...abcd')

    expect(runtime.relays).toEqual([
      expect.objectContaining({
        id: providerId,
        api_key: 'sk-isolated-provider-secret-abcd',
        models: ['gpt-5.4-mini']
      })
    ])
		expect(runtime.modelIds).toContain(`relay-${providerId}-gpt-5.4-mini`)

		const budget = await fixture.gateway.app.inject({
			method: 'PUT',
			url: `/api/v1/admin/providers/${providerId}/internal-budget`,
			headers: headers(),
			payload: { internalBudgetCredits: '250.5' }
		})
		expect(budget.statusCode).toBe(200)
		expect(budget.json()).toMatchObject({
			config: { internalBudgetCredits: '250.500000' },
			usage: {
				requests: 0,
				settledCredits: '0.000000',
				internalBudgetCredits: '250.500000',
				remainingCredits: '250.500000',
				usedPercent: '0'
			}
		})
		const admin = await fixture.database.db
			.selectFrom('accounts')
			.select('id')
			.where('role', '=', 'level1')
			.executeTakeFirstOrThrow()
		await fixture.database.db.insertInto('organizations').values({
			id: 'org_provider_usage',
			name: 'Provider Usage Org',
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
			id: 'period_provider_usage',
			organization_id: 'org_provider_usage',
			period_start: '2026-07-01T00:00:00.000Z',
			period_end: '2026-08-01T00:00:00.000Z',
			allocated_credits: '1000.000000',
			settled_credits: '5.000000',
			created_at: '2026-07-01T00:00:00.000Z',
			closed_at: null,
			version: 1
		}).execute()
		await fixture.database.db.insertInto('usage_records').values({
			id: 'usage_provider_1',
			turn_id: 'turn_provider_usage_1',
			account_id: admin.id,
			organization_id: 'org_provider_usage',
			period_id: 'period_provider_usage',
			model_id: `relay-${providerId}-gpt-5.4-mini`,
			provider_id: providerId,
			input_tokens: 1200,
			output_tokens: 300,
			usage_source: 'upstream',
			input_credits: '3.000000',
			output_credits: '2.000000',
			total_credits: '5.000000',
			started_at: '2026-07-18T10:00:00.000Z',
			completed_at: '2026-07-18T10:01:00.000Z',
			route_error_code: null
		}).execute()
		const providerUsage = await fixture.gateway.app.inject({
			method: 'GET',
			url: `/api/v1/admin/providers/${providerId}`,
			headers: headers()
		})
		expect(providerUsage.json().usage).toEqual({
			requests: 1,
			inputTokens: 1200,
			outputTokens: 300,
			settledCredits: '5.000000',
			internalBudgetCredits: '250.500000',
			remainingCredits: '245.500000',
			usedPercent: '1.9',
			lastUsedAt: '2026-07-18T10:01:00.000Z'
		})
		const invalidBudget = await fixture.gateway.app.inject({
			method: 'PUT',
			url: `/api/v1/admin/providers/${providerId}/internal-budget`,
			headers: headers(),
			payload: { internalBudgetCredits: '-1' }
		})
		expect(invalidBudget.statusCode).toBe(400)
		expect(invalidBudget.json().error.code).toBe('invalid_provider_budget')

    const models = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/models',
      headers: headers()
    })
    expect(models.statusCode).toBe(200)
    expect(models.json().models).toEqual([
      expect.objectContaining({
        publicModelId: `relay-${providerId}-gpt-5.4-mini`,
        providerId,
        enabled: true
      })
    ])

    const publicModelId = `relay-${providerId}-gpt-5.4-mini`
    const routeDisabled = await fixture.gateway.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/models/${encodeURIComponent(publicModelId)}`,
      headers: headers(),
      payload: {
        providerId,
        upstreamModelId: 'gpt-5.4-mini',
        priority: 1,
        enabled: false
      }
    })
    expect(routeDisabled.statusCode).toBe(200)
    expect(routeDisabled.json().enabled).toBe(false)
    expect(runtime.modelIds).not.toContain(publicModelId)

    const disabled = await fixture.gateway.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: headers(),
      payload: { status: 'disabled' }
    })
    expect(disabled.statusCode).toBe(200)
    expect(runtime.relays).toEqual([])
  })

  it('redacts Provider diagnostics even when an adapter returns unsafe values', async () => {
    const response = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/diagnostics',
      headers: headers()
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('diagnostic-secret')
    expect(response.json().providers.relay_test.apiKey).toBe('[REDACTED]')

    const circuits = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/diagnostics/circuits',
      headers: headers()
    })
    expect(circuits.json()).toEqual({
      circuits: { relay_test: { state: 'closed' } }
    })
  })

  it('starts official ChatGPT login and imports the result into Gateway storage', async () => {
    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: {
        kind: 'chatgpt',
        displayName: 'Official ChatGPT',
        config: { models: ['gpt-5.4'] }
      }
    })
    const providerId = created.json().id as string
    const started = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/chatgpt-login/start`,
      headers: headers()
    })
    expect(started.statusCode).toBe(202)
    expect(started.json()).toMatchObject({
      id: 'oauth_test',
      status: 'waiting',
      verificationUrl: 'https://auth.openai.com/authorize'
    })
    expect(loginProviderId).toBe(providerId)

    const status = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/providers/${providerId}/chatgpt-login/status`,
      headers: headers()
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().status).toBe('waiting')

    await importChatgptCredential?.(JSON.stringify({
      tokens: {
        access_token: 'chatgpt-access-secret',
        refresh_token: 'chatgpt-refresh-secret',
        account_id: 'chatgpt-account-test'
      }
    }))
    const listed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers',
      headers: headers()
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain('chatgpt-access-secret')
    expect(listed.body).not.toContain('chatgpt-refresh-secret')
    expect(listed.json().providers[0].credentials[0].storageFormat)
      .toBe('envelope-v1')
		const credentialId = listed.json().providers[0].credentials[0].id as string
		expect(runtime.chatgptAccounts).toEqual([
			expect.objectContaining({
				id: credentialId,
				account_id: 'chatgpt-account-test',
				access_token: 'chatgpt-access-secret',
				refresh_token: 'chatgpt-refresh-secret'
			})
		])
		expect(listed.json().providers[0].credentials[0]).toMatchObject({
			label: 'Official ChatGPT',
			status: 'active',
			quota: {
				source: 'provider',
				primary: { remainingPercent: 80 }
			},
			runtime: { activeRequests: 1, concurrencyLimit: 3 },
			health: { requests: 10, successRate: 90 }
		})

		const routing = await fixture.gateway.app.inject({
			method: 'PATCH',
			url: `/api/v1/admin/providers/${providerId}/credentials/${credentialId}/routing`,
			headers: headers(),
			payload: {
				label: '主订阅账号',
				routingEnabled: true,
				routingWeight: 9,
				lowQuotaThreshold: 15,
				dailyRequestLimit: 120,
				dailyTokenLimit: 500_000,
				reservedModels: ['gpt-5.4']
			}
		})
		expect(routing.statusCode).toBe(200)
		expect(runtime.chatgptAccounts[0]).toMatchObject({
			id: credentialId,
			label: '主订阅账号',
			routing_enabled: true,
			routing_weight: 9,
			low_quota_threshold: 15,
			daily_request_limit: 120,
			daily_token_limit: 500_000,
			reserved_models: ['gpt-5.4']
		})

		const strategy = await fixture.gateway.app.inject({
			method: 'PUT',
			url: `/api/v1/admin/providers/${providerId}/account-routing-strategy`,
			headers: headers(),
			payload: { strategy: 'weighted' }
		})
		expect(strategy.statusCode).toBe(200)
		expect(runtime.chatgptAccountStrategy).toBe('weighted')

		const refreshed = await fixture.gateway.app.inject({
			method: 'POST',
			url: `/api/v1/admin/providers/${providerId}/credentials/${credentialId}/refresh-usage`,
			headers: headers()
		})
		expect(refreshed.statusCode).toBe(200)
		expect(refreshedAccountId).toBe(credentialId)

    const invalidManualCredential = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/credentials`,
      headers: headers(),
      payload: { secret: 'not-json-credential' }
    })
    expect(invalidManualCredential.statusCode).toBe(200)
    expect(runtime.chatgptAccounts).toHaveLength(1)
  })

  it('routes newly imported ChatGPT accounts by default while preserving explicit opt-out', async () => {
    const authJson = JSON.stringify({
      tokens: {
        access_token: 'default-routing-access-secret',
        refresh_token: 'default-routing-refresh-secret',
        account_id: 'default-routing-account-id'
      }
    })
    const enabled = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/import',
      headers: headers(),
      payload: { authJson, label: '默认路由账号' }
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      created: true,
      routingEnabled: true
    })
    expect(runtime.chatgptAccounts).toEqual([
      expect.objectContaining({
        account_id: 'default-routing-account-id',
        routing_enabled: true
      })
    ])

    const disabled = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/import',
      headers: headers(),
      payload: {
        authJson,
        label: '仅保存账号',
        routingEnabled: false
      }
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({
      created: false,
      routingEnabled: false
    })
    expect(runtime.chatgptAccounts).toEqual([
      expect.objectContaining({
        account_id: 'default-routing-account-id',
        routing_enabled: false
      })
    ])
  })

  it('imports a ChatGPT account through one shortcut, creates the default pool and updates duplicates', async () => {
    const first = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/import',
      headers: headers(),
      payload: {
        authJson: JSON.stringify({
          tokens: {
            access_token: 'shortcut-access-secret-one',
            refresh_token: 'shortcut-refresh-secret-one',
            account_id: 'shortcut-account-id'
          }
        }),
        label: '主订阅账号',
        routingEnabled: false
      }
    })
    expect(first.statusCode).toBe(200)
    expect(first.body).not.toContain('shortcut-access-secret-one')
    expect(first.body).not.toContain('shortcut-refresh-secret-one')
    expect(first.json()).toMatchObject({
      created: true,
      routingEnabled: false,
      accountIdPreview: 'shortcut…t-id'
    })

    const providerId = first.json().providerId as string
    const credentialId = first.json().credentialId as string
    const listed = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers',
      headers: headers()
    })
    expect(listed.json().providers).toHaveLength(1)
    expect(listed.json().providers[0]).toMatchObject({
      id: providerId,
      kind: 'chatgpt',
      displayName: 'ChatGPT 订阅池',
      config: {
        models: [
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.4-mini'
        ]
      }
    })
    expect(listed.json().providers[0].credentials[0]).toMatchObject({
      id: credentialId,
      label: '主订阅账号',
      routing: { enabled: false }
    })
    expect(runtime.chatgptAccounts).toEqual([
      expect.objectContaining({
        id: credentialId,
        account_id: 'shortcut-account-id',
        routing_enabled: false
      })
    ])

    const second = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/import',
      headers: headers(),
      payload: {
        authJson: JSON.stringify({
          tokens: {
            access_token: 'shortcut-access-secret-two',
            refresh_token: 'shortcut-refresh-secret-two',
            account_id: 'shortcut-account-id'
          }
        }),
        label: '更新后的账号',
        routingEnabled: true
      }
    })
    expect(second.statusCode).toBe(200)
    expect(second.body).not.toContain('shortcut-access-secret-two')
    expect(second.body).not.toContain('shortcut-refresh-secret-two')
    expect(second.json()).toMatchObject({
      providerId,
      credentialId,
      created: false,
      routingEnabled: true
    })
    expect(runtime.chatgptAccounts).toEqual([
      expect.objectContaining({
        id: credentialId,
        label: '更新后的账号',
        access_token: 'shortcut-access-secret-two',
        refresh_token: 'shortcut-refresh-secret-two',
        routing_enabled: true
      })
    ])
    const stored = await fixture.database.db
      .selectFrom('provider_credentials')
      .selectAll()
      .execute()
    expect(stored).toHaveLength(1)
    expect(stored[0].storage_kind).toBe('envelope-v1')
    expect(stored[0].key_version).toBe('test-kek-v1')
    expect(stored[0].credential_version).toBe(2)
    expect(stored[0].secret_payload).not.toContain('shortcut-access-secret-two')
    expect(stored[0].secret_payload).not.toContain('shortcut-access-secret-one')
  })

  it('starts the shortcut official login without a pre-created Provider', async () => {
    const started = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/login/start',
      headers: headers(),
      payload: {
        label: '官方登录账号',
        routingEnabled: false
      }
    })
    expect(started.statusCode).toBe(202)
    expect(started.json()).toMatchObject({
      providerId: loginProviderId,
      status: 'waiting',
      verificationUrl: 'https://auth.openai.com/authorize'
    })

    const status = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/chatgpt-accounts/login/status',
      headers: headers()
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      providerId: loginProviderId,
      status: 'waiting'
    })

    await importChatgptCredential?.(JSON.stringify({
      tokens: {
        access_token: 'official-shortcut-access',
        refresh_token: 'official-shortcut-refresh',
        account_id: 'official-shortcut-account'
      }
    }))
    expect(runtime.chatgptAccounts).toEqual([
      expect.objectContaining({
        label: '官方登录账号',
        account_id: 'official-shortcut-account',
        routing_enabled: false
      })
    ])
  })

  it('rejects malformed shortcut auth.json without creating a Provider', async () => {
    const invalid = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/chatgpt-accounts/import',
      headers: headers(),
      payload: {
        authJson: JSON.stringify({
          tokens: {
            access_token: 'access-only'
          }
        })
      }
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('invalid_chatgpt_auth_json')
    expect(await fixture.database.db
      .selectFrom('providers')
      .selectAll()
      .execute()).toHaveLength(0)
  })

  it('denies Provider APIs after the account loses Level-1 and writes a denied audit event', async () => {
    await fixture.database.db
      .updateTable('accounts')
      .set({ role: 'level2' })
      .execute()
    const denied = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers',
      headers: headers()
    })
		expect(denied.statusCode).toBe(403)
		expect(denied.json().error.code).toBe('forbidden')
		for (const request of [
			{
				method: 'PATCH' as const,
				url: '/api/v1/admin/providers/provider_forbidden/credentials/cred_forbidden/routing',
				payload: { routingEnabled: false }
			},
			{
				method: 'POST' as const,
				url: '/api/v1/admin/providers/provider_forbidden/credentials/cred_forbidden/refresh-usage'
			},
			{
				method: 'PUT' as const,
				url: '/api/v1/admin/providers/provider_forbidden/account-routing-strategy',
				payload: { strategy: 'weighted' }
			},
      {
        method: 'PUT' as const,
        url: '/api/v1/admin/providers/provider_forbidden/internal-budget',
        payload: { internalBudgetCredits: '100' }
      },
      {
        method: 'POST' as const,
        url: '/api/v1/admin/chatgpt-accounts/import',
        payload: { authJson: '{}' }
      },
      {
        method: 'POST' as const,
        url: '/api/v1/admin/chatgpt-accounts/login/start',
        payload: {}
      }
		]) {
			const mutation = await fixture.gateway.app.inject({
				...request,
				headers: headers()
			})
			expect(mutation.statusCode).toBe(403)
			expect(mutation.json().error.code).toBe('forbidden')
		}
		const audits = await fixture.database.db
			.selectFrom('admin_audit_events')
			.selectAll()
			.where('outcome', '=', 'denied')
			.execute()
		expect(audits.map(audit => audit.action)).toEqual(expect.arrayContaining([
			'provider.list',
			'provider.credential.routing.update',
      'provider.credential.usage.refresh',
      'provider.account_strategy.update',
      'provider.internal_budget.update',
      'provider.chatgpt_account.import',
      'provider.chatgpt_account.login.start'
    ]))
		expect(audits.every(audit => audit.safe_metadata_json === '{}')).toBe(true)
	})

  it('validates Provider kinds, URLs, status and public model identity', async () => {
    const invalidName = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: { kind: 'relay', displayName: '   ', config: {} }
    })
    expect(invalidName.statusCode).toBe(400)
    expect(invalidName.json().error.code).toBe('invalid_request')

    const invalidKind = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: { kind: 'unknown', displayName: 'Invalid', config: {} }
    })
    expect(invalidKind.statusCode).toBe(400)
    expect(invalidKind.json().error.code).toBe('invalid_provider_kind')

    const invalidUrl = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: {
        kind: 'relay',
        displayName: 'Invalid URL',
        config: { baseUrl: 'file:///tmp/provider', models: [] }
      }
    })
    expect(invalidUrl.statusCode).toBe(400)
    expect(invalidUrl.json().error.code).toBe('invalid_provider_url')

    const malformedUrl = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: {
        kind: 'relay',
        displayName: 'Malformed URL',
        config: { baseUrl: 'not-a-url', models: [] }
      }
    })
    expect(malformedUrl.statusCode).toBe(400)
    expect(malformedUrl.json().error.code).toBe('invalid_provider_url')

    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: {
        kind: 'openai',
        displayName: 'OpenAI API',
        config: { models: ['gpt-5.4-mini', 'invalid model name'] }
      }
    })
    expect(created.statusCode).toBe(200)
    const providerId = created.json().id as string
    expect(created.json().config).toEqual({
      models: ['gpt-5.4-mini']
    })

    const invalidStatus = await fixture.gateway.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: headers(),
      payload: { status: 'broken' }
    })
    expect(invalidStatus.statusCode).toBe(400)
    expect(invalidStatus.json().error.code).toBe('invalid_provider_status')

    const wrongModelId = await fixture.gateway.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/models/not-the-derived-model',
      headers: headers(),
      payload: {
        providerId,
        upstreamModelId: 'gpt-5.4-mini',
        enabled: true
      }
    })
    expect(wrongModelId.statusCode).toBe(400)
    expect(wrongModelId.json().error.code).toBe('invalid_public_model_id')

    const wrongLoginKind = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/chatgpt-login/start`,
      headers: headers()
    })
    expect(wrongLoginKind.statusCode).toBe(409)
    expect(wrongLoginKind.json().error.code).toBe('invalid_provider_kind')
  })

  it('supports credential removal, Provider deletion and diagnostic sections', async () => {
    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: headers(),
      payload: {
        kind: 'deepseek',
        displayName: 'DeepSeek',
        status: 'disabled',
        config: {
          baseUrl: 'https://api.deepseek.com/anthropic/v1/messages/',
          models: ['deepseek-v4-pro']
        }
      }
    })
    expect(created.statusCode).toBe(200)
    const providerId = created.json().id as string

    const updated = await fixture.gateway.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: headers(),
      payload: {
        displayName: 'DeepSeek Updated',
        status: 'active',
        config: {
          baseUrl: 'https://api.deepseek.com/anthropic/v1/messages',
          models: ['deepseek-v4-pro']
        }
      }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      displayName: 'DeepSeek Updated',
      status: 'active'
    })

    const credential = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/credentials`,
      headers: headers(),
      payload: { secret: 'deepseek-development-key' }
    })
    const credentialId = credential.json().id as string
    expect(runtime.deepseekApiKey).toBe('deepseek-development-key')

    const provider = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: headers()
    })
    expect(provider.statusCode).toBe(200)
    expect(provider.json().credentials).toHaveLength(1)

    const providerDiagnostics = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/diagnostics/providers',
      headers: headers()
    })
    expect(providerDiagnostics.statusCode).toBe(200)
    expect(providerDiagnostics.json()).toHaveProperty('providers')
    const recentErrors = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/api/v1/admin/diagnostics/recent-route-errors',
      headers: headers()
    })
    expect(recentErrors.json()).toEqual({ recentRouteErrors: [] })

    const removedCredential = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/providers/${providerId}/credentials/${credentialId}`,
      headers: headers()
    })
    expect(removedCredential.statusCode).toBe(204)
    expect(runtime.deepseekApiKey).toBe('')

    const missingCredential = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/providers/${providerId}/credentials/${credentialId}`,
      headers: headers()
    })
    expect(missingCredential.statusCode).toBe(404)

    const removedProvider = await fixture.gateway.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: headers()
    })
    expect(removedProvider.statusCode).toBe(204)
    const missingProvider = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: headers()
    })
    expect(missingProvider.statusCode).toBe(404)
  })
})
