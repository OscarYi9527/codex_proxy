import { AuditService } from '../../src/audit/audit-service.js'
import { SequenceIdSource } from '../../src/common/ids.js'
import { SafeLogger, type LogRecord } from '../../src/common/logging.js'
import { AuditRepository } from '../../src/db/repositories/audit-repository.js'
import {
  createRealGatewayFixture,
  loginBootstrapAndExchange,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

const secrets = {
  apiKey: ['sk', 'proj', 'security-scan-fixture-123456789'].join('-'),
  bearer: 'eyJhbGciOiJIUzI1NiJ9.security.payload',
  password: 'NeverPersistThisPassword123',
  file: 'FILE-CONTENT-MUST-NOT-PERSIST',
  tool: 'TOOL-OUTPUT-MUST-NOT-PERSIST',
  system: 'SYSTEM-PROMPT-MUST-NOT-PERSIST'
}

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret)
}

describe('secret leak regression scan (T109)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => fixture.gateway.close())

  it('keeps DB, admin API, log and export-shaped audit fixtures free of secrets', async () => {
    const initial = await loginBootstrapAndExchange(fixture)
    const changed = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/account/password/change',
      headers: { authorization: `Bearer ${initial.accessToken}` },
      payload: {
        currentPassword: fixture.bootstrap.password,
        newPassword: 'PermanentPassword123',
        email: 'security@example.test'
      }
    })
    const accessToken = changed.json().accessToken as string
    const adminId = (await fixture.database.db
      .selectFrom('accounts')
      .select('id')
      .where('role', '=', 'level1')
      .executeTakeFirstOrThrow()).id
    const organization = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/admin/organizations',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Security Scan Organization' }
    })
    const organizationId = organization.json().id as string
    await fixture.database.db.updateTable('accounts')
      .set({ organization_id: organizationId })
      .where('id', '=', adminId)
      .execute()

    const repository = new AuditRepository(
      fixture.database.db,
      callback => fixture.database.inTransaction(callback)
    )
    const audit = new AuditService(repository, fixture.clock, new SequenceIdSource())
    const identity = {
      accountId: adminId,
      deviceSessionId: changed.json().deviceSessionId as string,
      role: 'level1' as const,
      organizationId,
      accountVersion: 1,
      passwordVersion: 2
    }
    const persisted = await audit.recordConversation({
      identity,
      turnId: 'turn_security_scan',
      modelId: 'security-scan-model',
      requestBody: {
        instructions: secrets.system,
        input: [{
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `normal question api_key=${secrets.apiKey} password=${secrets.password}`
            },
            { type: 'input_file', file_data: secrets.file }
          ]
        }, {
          type: 'function_call_output',
          output: secrets.tool
        }]
      },
      assistantText: `normal answer Bearer ${secrets.bearer}`,
      inputTokens: 20,
      outputTokens: 10
    })
    expect(persisted).not.toBeNull()
    await audit.recordAdminEvent(identity, {
      organizationId,
      action: 'security.scan',
      targetType: 'fixture',
      targetId: 'fixture_1',
      outcome: 'allowed',
      metadata: {
        authJson: secrets.apiKey,
        nested: { apiKey: secrets.apiKey, harmless: 'retained' }
      }
    })

    const detail = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit/conversations/${persisted!.id}`,
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(detail.statusCode).toBe(200)

    const logRecords: LogRecord[] = []
    new SafeLogger({
      clock: fixture.clock,
      sink: record => logRecords.push(record)
    }).info('security_scan', {
      authorization: `Bearer ${secrets.bearer}`,
      apiKey: secrets.apiKey,
      password: secrets.password
    })

    const databaseRows = {
      conversation: await fixture.database.db
        .selectFrom('conversation_audits')
        .selectAll()
        .where('turn_id', '=', 'turn_security_scan')
        .executeTakeFirstOrThrow(),
      adminEvents: await fixture.database.db
        .selectFrom('admin_audit_events')
        .selectAll()
        .where('actor_account_id', '=', adminId)
        .execute()
    }
    const exportFixture = {
      conversations: await repository.listConversations({ organizationId }),
      adminEvents: await repository.listAdminEvents({ organizationId })
    }

    expectNoSecrets(databaseRows)
    expectNoSecrets(detail.json())
    expectNoSecrets(logRecords)
    expectNoSecrets(exportFixture)
    expect(databaseRows.conversation.user_text_sanitized).toContain('[REDACTED]')
    expect(databaseRows.conversation.assistant_text_sanitized).toContain('[REDACTED]')
    expect(JSON.stringify(exportFixture)).toContain('harmless')
  })
})
