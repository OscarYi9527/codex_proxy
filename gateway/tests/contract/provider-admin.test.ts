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
      storageFormat: 'plaintext-v1',
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
    expect(listed.json().warning).toMatch(/plaintext-v1/)
    expect(listed.json().providers[0].credentials[0].maskedPreview).toBe('sk-...abcd')

    expect(runtime.relays).toEqual([
      expect.objectContaining({
        id: providerId,
        api_key: 'sk-isolated-provider-secret-abcd',
        models: ['gpt-5.4-mini']
      })
    ])
    expect(runtime.modelIds).toContain(`relay-${providerId}-gpt-5.4-mini`)

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
      .toBe('plaintext-v1')
    expect(runtime.chatgptAccounts).toEqual([
      expect.objectContaining({
        id: 'chatgpt-account-test',
        access_token: 'chatgpt-access-secret',
        refresh_token: 'chatgpt-refresh-secret'
      })
    ])

    const invalidManualCredential = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/credentials`,
      headers: headers(),
      payload: { secret: 'not-json-credential' }
    })
    expect(invalidManualCredential.statusCode).toBe(200)
    expect(runtime.chatgptAccounts).toHaveLength(1)
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
    const audit = await fixture.database.db
      .selectFrom('admin_audit_events')
      .selectAll()
      .where('outcome', '=', 'denied')
      .executeTakeFirstOrThrow()
    expect(audit.action).toBe('provider.list')
    expect(audit.safe_metadata_json).toBe('{}')
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
