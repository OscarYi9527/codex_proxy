import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('Gateway authenticated model and Responses contract (T039/T043-T046)', () => {
  let fixture: RealGatewayFixture
  let accessToken: string
  let deviceSessionId: string

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
    expect(changed.statusCode).toBe(200)
    accessToken = changed.json().accessToken
    deviceSessionId = changed.json().deviceSessionId
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('returns authenticated non-Mock models without Provider internals', async () => {
    const response = await fixture.gateway.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      object: 'list',
      data: [{ id: 'real-test-model', object: 'model', owned_by: 'ai-editor' }]
    })
    expect(response.body).not.toMatch(/gpt-mock|credential|circuit|cost|route/i)
  })

  it('blocks the model catalog until the bootstrap password and email are replaced', async () => {
    const bootstrapFixture = await createRealGatewayFixture()
    try {
      const initial = await loginBootstrapAndExchange(bootstrapFixture)
      const response = await bootstrapFixture.gateway.app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${initial.accessToken}` }
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('password_change_required')
    } finally {
      await bootstrapFixture.gateway.close()
    }
  })

  it('requires product identity, matching device session, Turn ID and enabled model', async () => {
    const missing = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(missing.statusCode).toBe(401)
    expect(missing.json().error.code).toBe('login_required')

    const wrongSession = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-ai-editor-device-session': 'ds_wrong',
        'x-ai-editor-turn-id': 'turn_contract_1234'
      },
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(wrongSession.statusCode).toBe(401)

    const missingTurn = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-ai-editor-device-session': deviceSessionId
      },
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(missingTurn.statusCode).toBe(400)
    expect(missingTurn.json().error.code).toBe('invalid_turn_id')

    const unavailable = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-ai-editor-device-session': deviceSessionId,
        'x-ai-editor-turn-id': 'turn_contract_1234'
      },
      payload: { model: 'gpt-mock', input: 'hello' }
    })
    expect(unavailable.statusCode).toBe(409)
    expect(unavailable.json().error.code).toBe('provider_unavailable')
  })

  it('rejects invalid bodies, unsupported compatibility routes and safe adapter failures', async () => {
    const commonHeaders = {
      authorization: `Bearer ${accessToken}`,
      'x-ai-editor-device-session': deviceSessionId
    }
    const invalidBody = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        ...commonHeaders,
        'x-ai-editor-turn-id': 'turn_invalid_body_1234'
      },
      payload: []
    })
    expect(invalidBody.statusCode).toBe(400)
    expect(invalidBody.json().error.code).toBe('invalid_request')

    const unsupportedChat = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        ...commonHeaders,
        'x-ai-editor-turn-id': 'turn_unsupported_chat_1234'
      },
      payload: { model: 'real-test-model', messages: [] }
    })
    expect(unsupportedChat.statusCode).toBe(409)
    expect(unsupportedChat.json().error.code).toBe('provider_unavailable')

    const adapterFailure = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        ...commonHeaders,
        'x-ai-editor-turn-id': 'turn_adapter_failure_1234'
      },
      payload: { model: 'real-test-model', input: 'hello' }
    })
    expect(adapterFailure.statusCode).toBe(500)
    expect(adapterFailure.json().error.code).toBe('internal_error')
  })
})

describe('Gateway Responses stream compatibility', () => {
  it('reserves risk and settles upstream usage for an organization account', async () => {
    const now = '2026-07-17T00:00:00.000Z'
    let acknowledgedSettlementId: string | undefined
    const fixture = await createRealGatewayFixture({
      providerAdapter: {
        async listModels() {
          return {
            object: 'list',
            data: [{ id: 'billable-model', object: 'model', owned_by: 'test' }]
          }
        },
        async forwardResponses(_request, reply) {
          await reply.status(200).send({
            id: 'response_billable',
            usage: { input_tokens: 10, output_tokens: 20 }
          })
          return {
            providerId: 'provider_billable',
            assistantText: 'final answer password=AssistantSecret123',
            usage: { inputTokens: 10, outputTokens: 20 },
            usageReceipt: {
              schemaVersion: 1,
              outboxId: 'outbox_billable',
              executionId: 'exec_billable',
              turnId: 'turn_billable_1234',
              workerId: 'worker-local',
              region: 'local-development',
              providerId: 'provider_billable',
              inputTokens: 10,
              outputTokens: 20,
              completedAt: now,
              signature: `v1=${'a'.repeat(64)}`
            }
          }
        },
        async acknowledgeSettlement(_result, usage) {
          acknowledgedSettlementId = usage.id
        }
      }
    })
    try {
      const initial = await loginBootstrapAndExchange(fixture)
      const changed = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/account/password/change',
        headers: { authorization: `Bearer ${initial.accessToken}` },
        payload: {
          currentPassword: fixture.bootstrap.password,
          newPassword: 'PermanentPassword123',
          email: 'billing@example.test'
        }
      })
      const changedTokens = changed.json()
      const accountId = (await fixture.database.db.selectFrom('accounts')
        .select('id')
        .where('role', '=', 'level1')
        .executeTakeFirstOrThrow()).id
      await fixture.database.db.insertInto('organizations').values({
        id: 'org_billable',
        name: 'Billable organization',
        status: 'active',
        billing_timezone: 'Asia/Shanghai',
        audit_retention_days: 30,
        overdraft_per_turn_override: null,
        cumulative_risk_override: null,
        created_at: now,
        updated_at: now,
        version: 1
      }).execute()
      await fixture.database.db.updateTable('accounts')
        .set({ organization_id: 'org_billable', version: 2 })
        .where('id', '=', accountId)
        .execute()
      await fixture.database.db.insertInto('providers').values({
        id: 'provider_billable',
        kind: 'relay',
        display_name: 'Billable provider',
        status: 'active',
        config_json: '{}',
        created_at: now,
        updated_at: now,
        version: 1
      }).execute()
      await fixture.database.db.insertInto('model_routes').values({
        id: 'route_billable',
        public_model_id: 'billable-model',
        provider_id: 'provider_billable',
        upstream_model_id: 'billable-model',
        priority: 1,
        enabled: 1,
        policy_json: '{}',
        created_at: now,
        updated_at: now,
        version: 1
      }).execute()
      await fixture.database.db.insertInto('model_rates').values({
        id: 'rate_billable',
        model_id: 'billable-model',
        input_credit_per_token: '0.001000',
        output_credit_per_token: '0.002000',
        multiplier: '1.000000',
        effective_from: now,
        effective_to: null,
        visible_to: 'level1'
      }).execute()

      const refreshed = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/api/v1/oauth/token',
        payload: {
          grantType: 'refresh_token',
          clientId: 'ai-editor-edge',
          refreshToken: changedTokens.refreshToken,
          deviceSessionId: changedTokens.deviceSessionId
        }
      })
      const tokens = refreshed.json()
      const adminHeaders = {
        authorization: `Bearer ${tokens.accessToken}`
      }
      expect((await fixture.gateway.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/organizations/org_billable/monthly-credits',
        headers: adminHeaders,
        payload: { allocatedCredits: '100' }
      })).statusCode).toBe(200)
      expect((await fixture.gateway.app.inject({
        method: 'PUT',
        url: `/api/v1/admin/accounts/${accountId}/credit-allocation`,
        headers: adminHeaders,
        payload: { allocatedCredits: '100' }
      })).statusCode).toBe(204)
      const response = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'x-ai-editor-device-session': tokens.deviceSessionId,
          'x-ai-editor-turn-id': 'turn_billable_1234'
        },
        payload: {
          model: 'billable-model',
          instructions: 'SYSTEM-INSTRUCTION-MUST-NOT-BE-AUDITED',
          input: [{
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `hello api_key=${['sk', 'proj', 'audit-secret-123456'].join('-')}`
              },
              { type: 'input_file', filename: 'secret.txt', file_data: 'FILE-MUST-NOT-BE-AUDITED' }
            ]
          }, {
            type: 'function_call_output',
            call_id: 'call_audit',
            output: 'TOOL-MUST-NOT-BE-AUDITED'
          }],
          max_output_tokens: 100
        }
      })
      expect(response.statusCode).toBe(200)
      const usage = await fixture.database.db.selectFrom('usage_records')
        .selectAll()
        .where('turn_id', '=', 'turn_billable_1234')
        .executeTakeFirstOrThrow()
      expect(usage).toMatchObject({
        input_tokens: 10,
        output_tokens: 20,
        usage_source: 'upstream',
        total_credits: '0.050000'
      })
      expect(acknowledgedSettlementId).toBe(usage.id)
      const allocation = await fixture.database.db
        .selectFrom('user_credit_allocations')
        .select(['settled_credits', 'allocated_credits'])
        .where('account_id', '=', accountId)
        .executeTakeFirstOrThrow()
      expect(allocation).toEqual({
        settled_credits: '0.050000',
        allocated_credits: '100.000000'
      })
      const audit = await fixture.database.db
        .selectFrom('conversation_audits')
        .selectAll()
        .where('turn_id', '=', 'turn_billable_1234')
        .executeTakeFirstOrThrow()
      expect(audit).toMatchObject({
        organization_id: 'org_billable',
        account_id: accountId,
        model_id: 'billable-model',
        input_tokens: 10,
        output_tokens: 20,
        body_deleted_at: null
      })
      expect(audit.user_text_sanitized).toContain('hello api_key=[REDACTED]')
      expect(audit.assistant_text_sanitized).toContain('password=[REDACTED]')
      expect(JSON.stringify(audit)).not.toMatch(
        /SYSTEM-INSTRUCTION|FILE-MUST-NOT|TOOL-MUST-NOT|sk-proj-audit|AssistantSecret123/
      )
    } finally {
      await fixture.gateway.close()
    }
  })

  it('passes a validated request to the Provider adapter and preserves SSE', async () => {
    let forwardedModel: string | undefined
    const fixture = await createRealGatewayFixture({
      providerAdapter: {
        async listModels() {
          return {
            object: 'list',
            data: [{ id: 'real-stream-model', object: 'model', owned_by: 'test' }]
          }
        },
        async forwardResponses(_request, reply, body) {
          forwardedModel = body.model as string
          await reply
            .status(200)
            .header('content-type', 'text/event-stream')
            .send('event: response.completed\ndata: {"type":"response.completed"}\n\n')
        }
      }
    })
    try {
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
      const tokens = changed.json()
      const response = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'x-ai-editor-device-session': tokens.deviceSessionId,
          'x-ai-editor-turn-id': 'turn_stream_123456'
        },
        payload: { model: 'real-stream-model', input: 'hello', stream: true }
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('response.completed')
      expect(forwardedModel).toBe('real-stream-model')
    } finally {
      await fixture.gateway.close()
    }
  })

  it('forwards Chat Completions where the Provider adapter supports it', async () => {
    let forwarded = false
    const fixture = await createRealGatewayFixture({
      providerAdapter: {
        async listModels() {
          return {
            object: 'list',
            data: [{ id: 'real-chat-model', object: 'model', owned_by: 'test' }]
          }
        },
        async forwardResponses() {
          throw new Error('Responses adapter should not be selected')
        },
        async forwardChatCompletions(_request, reply, body) {
          forwarded = body.model === 'real-chat-model'
          await reply
            .status(200)
            .header('content-type', 'application/json')
            .send({ id: 'chatcmpl-real', choices: [] })
        }
      }
    })
    try {
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
      const tokens = changed.json()
      const response = await fixture.gateway.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'x-ai-editor-device-session': tokens.deviceSessionId,
          'x-ai-editor-turn-id': 'turn_chat_12345678'
        },
        payload: { model: 'real-chat-model', messages: [], stream: false }
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().id).toBe('chatcmpl-real')
      expect(forwarded).toBe(true)
    } finally {
      await fixture.gateway.close()
    }
  })
})
