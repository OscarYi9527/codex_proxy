import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import type { ManagementApiClient } from './api-client'
import type { AccountRole, ManagementRoute } from './types'

const account = {
  account: {
    id: 'acct_test',
    email: 'user@example.test',
    loginName: null,
    role: 'user' as const,
    status: 'active',
    expiresAt: null,
    organization: { id: 'org_test', name: '示例组织' },
    mustChangePassword: false,
    mustProvideEmail: false
  },
  credits: {
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    allocated: '100.000000',
    settled: '12.500000',
    available: '87.500000'
  }
}

function clientFor(role: AccountRole): ManagementApiClient {
  const navigationByRole: Record<AccountRole, Array<{ id: ManagementRoute; label: string }>> = {
    user: [
      { id: 'account', label: '我的账号' },
      { id: 'security', label: '设备与安全' },
      { id: 'usage', label: '使用记录' }
    ],
    level2: [
      { id: 'account', label: '我的账号' },
      { id: 'security', label: '设备与安全' },
      { id: 'usage', label: '使用记录' },
      { id: 'organization', label: '组织用户' },
      { id: 'invitations', label: '邀请码' }
    ],
    level1: [
      { id: 'account', label: '我的账号' },
      { id: 'security', label: '设备与安全' },
      { id: 'usage', label: '使用记录' },
      { id: 'organization', label: '组织用户' },
      { id: 'invitations', label: '邀请码' },
      { id: 'providers', label: 'Provider 与模型' },
      { id: 'diagnostics', label: '系统诊断' }
    ]
  }
  return {
    exchangeTicket: async () => ({
      expiresIn: 1800,
      account: { id: 'acct_test', role },
      navigation: navigationByRole[role]
    }),
    account: async () => ({
      ...account,
      account: { ...account.account, role }
    }),
    devices: async () => [{
      id: 'ds_test',
      name: '测试电脑',
      platform: 'windows',
      createdAt: '2026-07-17T00:00:00.000Z',
      lastUsedAt: '2026-07-17T01:00:00.000Z',
      expiresAt: '2026-08-17T00:00:00.000Z',
      revokedAt: null,
      current: true
    }],
    changePassword: jest.fn(async () => undefined),
    revokeDevice: jest.fn(async () => undefined),
    usage: async () => ({
      summary: {
        requests: 1,
        inputTokens: 20,
        outputTokens: 10,
        settledCredits: '12.500000'
      },
      records: [{
        id: 'usage_test',
        turnId: 'turn_test',
        modelId: 'real-model',
        inputTokens: 20,
        outputTokens: 10,
        totalCredits: '12.500000',
        usageSource: 'upstream',
        completedAt: '2026-07-17T01:00:00.000Z'
      }]
    }),
    providers: jest.fn(async () => ({
      warning: 'plaintext-v1 is for loopback development only',
      providers: [{
        id: 'provider_test',
        kind: 'relay' as const,
        displayName: 'Local Relay',
        status: 'active' as const,
        config: {
          baseUrl: 'http://127.0.0.1:40123/v1',
          models: ['gpt-5.4-mini']
        },
        version: 1,
        updatedAt: '2026-07-17T01:00:00.000Z',
        credentials: [{
          id: 'cred_test',
          maskedPreview: 'sk-...abcd',
          storageFormat: 'plaintext-v1' as const,
          updatedAt: '2026-07-17T01:00:00.000Z',
          lastUsedAt: null
        }],
        plaintextWarning: 'plaintext-v1 is for loopback development only'
      }]
    })),
    createProvider: jest.fn(async (
      input: Parameters<ManagementApiClient['createProvider']>[0]
    ) => ({
      id: 'provider_created',
      kind: input.kind,
      displayName: input.displayName,
      status: 'active' as const,
      config: input.config,
      version: 1,
      updatedAt: '2026-07-17T01:00:00.000Z',
      credentials: [],
      plaintextWarning: null
    })),
    updateProvider: jest.fn(async (
      _providerId: string,
      input: Parameters<ManagementApiClient['updateProvider']>[1]
    ) => ({
      id: 'provider_test',
      kind: 'relay' as const,
      displayName: input.displayName || 'Local Relay',
      status: input.status || 'active',
      config: {
        baseUrl: 'http://127.0.0.1:40123/v1',
        models: ['gpt-5.4-mini']
      },
      version: 2,
      updatedAt: '2026-07-17T01:00:00.000Z',
      credentials: [],
      plaintextWarning: null
    })),
    deleteProvider: jest.fn(async () => undefined),
    addProviderCredential: jest.fn(async () => undefined),
    deleteProviderCredential: jest.fn(async () => undefined),
    startChatgptLogin: jest.fn(async () => ({ status: 'waiting' as const })),
    chatgptLoginStatus: jest.fn(async () => ({ status: 'waiting' as const })),
    models: jest.fn(async () => ({
      models: [{
        id: 'route_test',
        publicModelId: 'relay-provider_test-gpt-5.4-mini',
        providerId: 'provider_test',
        upstreamModelId: 'gpt-5.4-mini',
        priority: 1,
        enabled: true
      }]
    })),
    putModel: jest.fn(async () => undefined),
    diagnostics: jest.fn(async () => ({
      providers: {
        provider_test: { status: 'healthy', apiKey: '[REDACTED]' }
      },
      circuits: { provider_test: { state: 'closed' } },
      recentRouteErrors: []
    }))
  }
}

function bootstrap(route: ManagementRoute = 'account', origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin,
    data: {
      type: 'ai-editor-management-bootstrap',
      version: 1,
      route,
      ticket: 'one-time-management-ticket',
      expiresIn: 60
    }
  }))
}

describe('Gateway management shell role navigation (T050/T054/T055)', () => {
  it('accepts only the fixed same-window bootstrap envelope', async () => {
    render(<App client={clientFor('user')} />)
    bootstrap('account', 'https://evil.example')
    expect(screen.getByText(/等待 Code/)).toBeInTheDocument()
    bootstrap()
    expect(await screen.findByText('user@example.test')).toBeInTheDocument()
    expect(screen.getByText('87.500000')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/one-time-management-ticket/)
  })

  it.each([
    ['user', false, false],
    ['level2', true, false],
    ['level1', true, true]
  ] as const)('renders server-authorized navigation for %s', async (
    role,
    seesOrganization,
    seesProviders
  ) => {
    render(<App client={clientFor(role)} />)
    bootstrap()
    await screen.findByRole('navigation', { name: '管理导航' })
    expect(Boolean(screen.queryByRole('button', { name: '组织用户' })))
      .toBe(seesOrganization)
    expect(Boolean(screen.queryByRole('button', { name: 'Provider 与模型' })))
      .toBe(seesProviders)
  })

  it('shows devices and usage without exposing credentials or Provider internals', async () => {
    const client = clientFor('user')
    render(<App client={client} />)
    bootstrap('security')
    expect(await screen.findByText('测试电脑')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '使用记录' }))
    await waitFor(() => expect(screen.getByText('real-model')).toBeInTheDocument())
    expect(screen.getByText('12.500000 积分')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/refresh.?token|api.?key|circuit/i)
    expect(client.providers).not.toHaveBeenCalled()
    expect(client.models).not.toHaveBeenCalled()
    expect(client.diagnostics).not.toHaveBeenCalled()
  })

  it('submits password changes from the security page without retaining credentials in the DOM', async () => {
    const client = clientFor('user')
    const changePassword = jest.spyOn(client, 'changePassword')
    render(<App client={client} />)
    bootstrap('security')

    await screen.findByRole('heading', { name: '修改密码' })
    fireEvent.change(screen.getByLabelText('当前密码'), {
      target: { value: 'OldPassword123' }
    })
    fireEvent.change(screen.getByLabelText('新密码'), {
      target: { value: 'NewPassword123' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'OldPassword123',
      newPassword: 'NewPassword123',
      email: 'user@example.test'
    }))
    expect(screen.getByRole('alertdialog', { name: '密码修改成功' })).toHaveTextContent('重启 AI Editor')
    expect(document.body.textContent).not.toContain('OldPassword123')
    expect(document.body.textContent).not.toContain('NewPassword123')
  })

  it('shows an explicit failure prompt when a password change is rejected', async () => {
    const client = clientFor('user')
    jest.spyOn(client, 'changePassword').mockRejectedValueOnce(new Error('rejected'))
    render(<App client={client} />)
    bootstrap('security')

    await screen.findByRole('heading', { name: '修改密码' })
    fireEvent.change(screen.getByLabelText('当前密码'), {
      target: { value: 'WrongPassword123' }
    })
    fireEvent.change(screen.getByLabelText('新密码'), {
      target: { value: 'NewPassword123' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))

    expect(await screen.findByRole('alert', { name: '密码修改失败' }))
      .toHaveTextContent('密码未被修改')
  })

  it('loads Provider and redacted diagnostics only for a Level-1 session', async () => {
    const client = clientFor('level1')
    render(<App client={client} />)
    bootstrap('providers')

    expect(await screen.findByText('Local Relay')).toBeInTheDocument()
    expect(screen.getByText(/sk-\.\.\.abcd/)).toBeInTheDocument()
    expect(screen.getByText(/plaintext-v1 is for loopback/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('diagnostic-secret')

    fireEvent.click(screen.getByRole('button', { name: '系统诊断' }))
    expect(await screen.findByText(/REDACTED/)).toBeInTheDocument()
    expect(screen.getByText(/closed/)).toBeInTheDocument()
  })
})
