import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ManagementApiClient } from '../../app/api-client'
import { AuditPage } from './AuditPage'

function auditClient() {
  return {
    conversationAudits: jest.fn(async () => ({
      conversations: [{
        id: 'audit_1',
        turnId: 'turn_1',
        accountId: 'acct_1',
        organizationId: 'org_1',
        modelId: 'gpt-test',
        inputTokens: 20,
        outputTokens: 10,
        createdAt: '2026-07-18T10:00:00.000Z',
        bodyExpiresAt: '2026-08-17T10:00:00.000Z',
        bodyDeletedAt: null,
        redactionVersion: 1
      }, {
        id: 'audit_deleted',
        turnId: 'turn_deleted',
        accountId: 'acct_1',
        organizationId: 'org_1',
        modelId: 'gpt-test',
        inputTokens: 5,
        outputTokens: 3,
        createdAt: '2026-06-01T10:00:00.000Z',
        bodyExpiresAt: '2026-07-01T10:00:00.000Z',
        bodyDeletedAt: '2026-07-02T00:00:00.000Z',
        redactionVersion: 1
      }]
    })),
    conversationAudit: jest.fn(async (auditId: string) => ({
      id: auditId,
      turnId: `turn_${auditId}`,
      accountId: 'acct_1',
      organizationId: 'org_1',
      modelId: 'gpt-test',
      userText: auditId === 'audit_deleted' ? null : '已脱敏用户问题',
      assistantText: auditId === 'audit_deleted' ? null : '已脱敏 AI 回复',
      inputTokens: 20,
      outputTokens: 10,
      createdAt: '2026-07-18T10:00:00.000Z',
      bodyExpiresAt: '2026-08-17T10:00:00.000Z',
      bodyDeletedAt: auditId === 'audit_deleted'
        ? '2026-07-02T00:00:00.000Z'
        : null,
      redactionVersion: 1
    })),
    adminAuditEvents: jest.fn(async () => ({
      events: [{
        id: 'admin_audit_1',
        actorAccountId: 'acct_admin',
        actorRole: 'level2' as const,
        organizationId: 'org_1',
        action: 'audit.conversation.view',
        targetType: 'conversation_audit',
        targetId: 'audit_1',
        outcome: 'allowed' as const,
        errorCode: null,
        metadata: {},
        createdAt: '2026-07-18T10:01:00.000Z'
      }]
    })),
    setAuditRetention: jest.fn(async () => undefined)
  }
}

const organizations = [{
  id: 'org_1',
  name: '审计测试组织',
  status: 'active' as const,
  auditRetentionDays: 30,
  updatedAt: '2026-07-18T00:00:00.000Z',
  version: 1
}]

describe('audit management page (T102/T108)', () => {
  it('does not request audit data for an ordinary user', () => {
    const api = auditClient()
    render(
      <AuditPage
        role="user"
        organizations={organizations}
        client={api as unknown as ManagementApiClient}
      />
    )
    expect(screen.getByText('当前账号无权查看组织调用审计。')).toBeInTheDocument()
    expect(api.conversationAudits).not.toHaveBeenCalled()
    expect(api.adminAuditEvents).not.toHaveBeenCalled()
  })

  it('lets Level 2 view only server-scoped sanitized bodies without retention controls', async () => {
    const api = auditClient()
    render(
      <AuditPage
        role="level2"
        organizations={organizations}
        client={api as unknown as ManagementApiClient}
      />
    )
    expect((await screen.findAllByText('gpt-test')).length).toBe(2)
    expect(screen.queryByLabelText('正文保留天数')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '查看正文' })[0]!)
    expect(await screen.findByText('已脱敏用户问题')).toBeInTheDocument()
    expect(screen.getByText('已脱敏 AI 回复')).toBeInTheDocument()
    expect(api.conversationAudits).toHaveBeenCalledWith('org_1')
  })

  it('shows an explicit deleted-body state instead of an ambiguous empty record', async () => {
    const api = auditClient()
    render(
      <AuditPage
        role="level2"
        organizations={organizations}
        client={api as unknown as ManagementApiClient}
      />
    )
    await screen.findAllByText('gpt-test')
    fireEvent.click(screen.getAllByRole('button', { name: '正文已清理' })[0]!)
    expect(await screen.findByText('正文已按组织保留策略删除')).toBeInTheDocument()
  })

  it('allows Level 1 to update a selected organization retention period', async () => {
    const api = auditClient()
    render(
      <AuditPage
        role="level1"
        organizations={organizations}
        client={api as unknown as ManagementApiClient}
      />
    )
    await screen.findAllByText('gpt-test')
    fireEvent.change(screen.getByLabelText('正文保留天数'), {
      target: { value: '45' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存保留期' }))
    await waitFor(() => expect(api.setAuditRetention).toHaveBeenCalledWith('org_1', 45))
  })
})
