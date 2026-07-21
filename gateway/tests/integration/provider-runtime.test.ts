import http from 'node:http'
import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'
import type { GatewayProviderRuntimeConfiguration } from '../../src/routing/standalone-route-adapter.js'
import { ProviderCredentialVault } from '../../src/security/provider-credential-vault.js'
import { StaticProviderCredentialKeyring } from '../../src/security/provider-master-key.js'

describe('database Provider configuration drives the isolated runtime (T084-T087)', () => {
  let upstream: http.Server
  let fixture: RealGatewayFixture
  let observedUrl: string | undefined
  let observedAuthorization: string | undefined
  let observedBody: { model?: string; stream?: boolean } | undefined
  const previous: Record<string, string | undefined> = {}

  beforeEach(async () => {
    observedUrl = undefined
    observedAuthorization = undefined
    observedBody = undefined
    upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observedUrl = request.url
      observedAuthorization = request.headers.authorization
      observedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string
        stream?: boolean
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-database-provider',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-database-provider',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.4-mini',
        choices: [{
          index: 0,
          delta: { content: 'database-provider-real-chain' },
          finish_reason: null
        }]
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-database-provider',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', resolve)
    })
    for (const key of [
      'CODEX_RELAYS',
      'CODEX_PROXY_STORAGE_ROOT',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'CODEX_OPENAI_API_UPSTREAM',
      'CODEX_OPENAI_API_BASE_URL',
      'CODEX_CHATGPT_RESPONSES_URL'
    ]) {
      previous[key] = process.env[key]
      delete process.env[key]
    }
    fixture = await createRealGatewayFixture({ useDefaultProviderAdapter: true })
  })

  afterEach(async () => {
    await fixture.gateway.close()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('refreshes models and streams Responses after Level-1 configures a Relay', async () => {
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
    const tokens = changed.json()
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Invalid upstream address')

    const created = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: {
        kind: 'relay',
        displayName: 'Database Relay',
        config: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: ['gpt-5.4-mini']
        }
      }
    })
    expect(created.statusCode).toBe(200)
    const providerId = created.json().id as string
    const publicModelId = `relay-${providerId}-gpt-5.4-mini`

    const credential = await fixture.gateway.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${providerId}/credentials`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { secret: 'database-provider-secret' }
    })
    expect(credential.statusCode).toBe(200)

    const models = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    })
    expect(models.statusCode).toBe(200)
    expect(models.body).not.toContain('gpt-mock')
    expect(models.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: publicModelId })
    ]))

    const response = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'x-ai-editor-device-session': tokens.deviceSessionId,
        'x-ai-editor-turn-id': 'turn_database_provider_1234'
      },
      payload: {
        model: publicModelId,
        input: 'hello',
        stream: true
      }
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toContain('database-provider-real-chain')
    expect(response.body).toContain('response.completed')
    expect(observedUrl).toBe('/v1/chat/completions')
    expect(observedAuthorization).toBe('Bearer database-provider-secret')
    expect(observedBody).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true
    })

    const disabled = await fixture.gateway.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/providers/${providerId}`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { status: 'disabled' }
    })
    expect(disabled.statusCode).toBe(200)

    const modelsAfterDisable = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    })
    expect(modelsAfterDisable.statusCode).toBe(200)
    expect(modelsAfterDisable.json().data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: publicModelId })
    ]))
  })
})

describe('persisted Provider startup configuration', () => {
  it('applies existing database Providers during Gateway startup', async () => {
    let configured: GatewayProviderRuntimeConfiguration | undefined
    const keyring = new StaticProviderCredentialKeyring(
      'provider-startup-key',
      new Map([['provider-startup-key', new Uint8Array(32).fill(6)]])
    )
    const credentialVault = new ProviderCredentialVault(keyring)
    const fixture = await createRealGatewayFixture({
      providerCredentialKeyring: keyring,
      providerAdapter: {
        async listModels() {
          return { object: 'list', data: [] }
        },
        async forwardResponses() {
          throw new Error('not used')
        },
        async configureProviders(value) {
          configured = value
        }
      },
      prepareDatabase: async database => {
        await database.db.insertInto('providers').values({
          id: 'provider_seeded',
          kind: 'relay',
          display_name: 'Seeded Relay',
          status: 'active',
          config_json: JSON.stringify({
            baseUrl: 'http://127.0.0.1:40123/v1',
            models: ['gpt-5.4-mini']
          }),
          created_at: '2026-07-17T00:00:00.000Z',
          updated_at: '2026-07-17T00:00:00.000Z',
          version: 1
        }).execute()
        await database.db.insertInto('provider_credentials').values({
          id: 'credential_seeded',
          provider_id: 'provider_seeded',
          storage_kind: 'envelope-v1',
          secret_payload: credentialVault.seal('seeded-runtime-secret', {
            providerId: 'provider_seeded',
            credentialId: 'credential_seeded'
          }),
          created_at: '2026-07-17T00:00:00.000Z',
          updated_at: '2026-07-17T00:00:00.000Z'
        }).execute()
      }
    })
    try {
      expect(configured?.modelIds).toEqual([])
      expect(configured?.relays).toEqual([
        expect.objectContaining({
          id: 'provider_seeded',
          api_key: 'seeded-runtime-secret'
        })
      ])
    } finally {
      await fixture.gateway.close()
    }
  })

  it('fails startup when an encrypted Provider key is unavailable', async () => {
    const sourceKeyring = new StaticProviderCredentialKeyring(
      'provider-source-key',
      new Map([['provider-source-key', new Uint8Array(32).fill(7)]])
    )
    const sourceVault = new ProviderCredentialVault(sourceKeyring)
    const unavailableKeyring = new StaticProviderCredentialKeyring(
      'provider-other-key',
      new Map([['provider-other-key', new Uint8Array(32).fill(8)]])
    )
    await expect(createRealGatewayFixture({
      providerCredentialKeyring: unavailableKeyring,
      prepareDatabase: async database => {
        await database.db.insertInto('providers').values({
          id: 'provider_unreadable',
          kind: 'openai',
          display_name: 'Unreadable Provider',
          status: 'disabled',
          config_json: '{}',
          created_at: '2026-07-17T00:00:00.000Z',
          updated_at: '2026-07-17T00:00:00.000Z',
          version: 1
        }).execute()
        await database.db.insertInto('provider_credentials').values({
          id: 'credential_unreadable',
          provider_id: 'provider_unreadable',
          storage_kind: 'envelope-v1',
          secret_payload: sourceVault.seal('unreadable-provider-secret', {
            providerId: 'provider_unreadable',
            credentialId: 'credential_unreadable'
          }),
          created_at: '2026-07-17T00:00:00.000Z',
          updated_at: '2026-07-17T00:00:00.000Z'
        }).execute()
      }
    })).rejects.toThrow(/provider-source-key is unavailable/)
  })
})
