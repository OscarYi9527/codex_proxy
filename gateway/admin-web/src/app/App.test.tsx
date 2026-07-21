import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import type { ManagementApiClient } from './api-client'
import type {
  AccountRole,
  ManagementRoute,
  ProviderListResponse
} from './types'

const account = {
  account: {
    id: 'acct_test',
    email: 'user@example.test',
    loginName: null,
    role: 'user' as const,
    status: 'active' as const,
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
      { id: 'organization', label: '组织与用户' },
      { id: 'invitations', label: '邀请码' },
      { id: 'credits', label: '组织额度' },
      { id: 'audit', label: '调用审计' }
    ],
    level1: [
      { id: 'account', label: '我的账号' },
      { id: 'security', label: '设备与安全' },
      { id: 'usage', label: '使用记录' },
      { id: 'organization', label: '组织与用户' },
      { id: 'invitations', label: '邀请码' },
      { id: 'credits', label: '组织额度' },
      { id: 'audit', label: '调用审计' },
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
    publicMvpCapacity: jest.fn(async () => ({
      phase: 'public_mvp' as const,
      hardLimit: 30,
      admittedAccountCount: 1,
      remainingAccountCount: 29,
      longTermCoreReady: false,
      account31Blocked: true,
      includesAdministrators: true as const,
      updatedAt: '2026-07-21T00:00:00.000Z'
    })),
    organizations: jest.fn(async () => [{
      id: 'org_test',
      name: '示例组织',
      status: 'active' as const,
      auditRetentionDays: 30,
      updatedAt: '2026-07-17T01:00:00.000Z',
      version: 1
    }]),
    createOrganization: jest.fn(async (name: string) => ({
      id: 'org_created',
      name,
      status: 'active' as const,
      auditRetentionDays: 30,
      updatedAt: '2026-07-17T01:00:00.000Z',
      version: 1
    })),
    organizationAccounts: jest.fn(async () => [{
      id: 'acct_org_user',
      loginName: null,
      email: 'member@example.test',
      role: 'user' as const,
      status: 'active' as const,
      organizationId: 'org_test',
      expiresAt: null,
      version: 1
    }]),
    setAccountStatus: jest.fn(async () => undefined),
    setAccountRole: jest.fn(async (
      accountId: string,
      input: Parameters<ManagementApiClient['setAccountRole']>[1]
    ) => ({
      id: accountId,
      loginName: null,
      email: 'member@example.test',
      role: input.role,
      status: 'active' as const,
      organizationId: input.organizationId,
      expiresAt: null,
      version: 2
    })),
    invitations: jest.fn(async () => [{
      id: 'inv_test',
      organizationId: 'org_test',
      expiresAt: '2026-08-01T00:00:00.000Z',
      maxUses: 10,
      useCount: 2,
      status: 'active' as const,
      createdAt: '2026-07-17T01:00:00.000Z',
      revokedAt: null
    }]),
    createInvitation: jest.fn(async (
      input: Parameters<ManagementApiClient['createInvitation']>[0]
    ) => ({
      code: 'invite-only-once',
      ...input
    })),
    revokeInvitation: jest.fn(async () => undefined),
    organizationCredits: jest.fn(async () => ({
      organization: { id: 'org_test', name: '示例组织' },
      period: {
        id: 'period_test',
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
        allocated: '1000.000000',
        settled: '12.500000',
        available: '987.500000'
      },
      users: [{
        accountId: 'acct_org_user',
        display: 'member@example.test',
        allocated: '100.000000',
        settled: '12.500000',
        available: '87.500000',
        requests: 1,
        inputTokens: 20,
        outputTokens: 10
      }],
      usage: {
        requests: 1,
        inputTokens: 20,
        outputTokens: 10,
        settledCredits: '12.500000'
      },
      ...(role === 'level1' ? {
        riskPolicy: {
          maxOverdraftPerTurn: '100.000000',
          maxCumulativeRisk: '500.000000',
          activeRiskCredits: '0.000000'
        },
        modelRates: []
      } : {})
    })),
    setMonthlyCredits: jest.fn(async () => undefined),
    setUserCreditAllocation: jest.fn(async () => undefined),
    setRiskPolicy: jest.fn(async () => undefined),
    conversationAudits: jest.fn(async () => ({ conversations: [] })),
    conversationAudit: jest.fn(async () => {
      throw new Error('not used')
    }),
    adminAuditEvents: jest.fn(async () => ({ events: [] })),
    setAuditRetention: jest.fn(async () => undefined),
    providers: jest.fn(async () => ({
      warning: 'plaintext-v1 is for loopback development only',
      accountPool: {
        strategy: 'headroom' as const,
        accounts: [],
        queueDepth: 0,
        recentRouteDecisions: []
      },
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
          lastUsedAt: null,
          label: null,
          accountIdPreview: null,
          planType: null,
          status: 'unknown',
          routing: null,
          quota: {
            source: 'unavailable' as const,
            primary: null,
            secondary: null,
            updatedAt: null,
            syncStatus: 'unavailable',
            syncError: null
          },
          runtime: {
            activeRequests: 0,
            concurrencyLimit: 0,
            cooldownUntil: null,
            modelCooldowns: 0
          },
          health: {
            requests: 0,
            successRate: null,
            p95LatencyMs: 0,
            rateLimited: 0,
            lastRequestAt: null,
            lastErrorType: null,
            lastErrorMessage: null
          }
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
    importChatgptAccount: jest.fn(async () => ({
      providerId: 'provider_chatgpt',
      credentialId: 'credential_chatgpt',
      accountIdPreview: 'account…test',
      created: true,
      routingEnabled: false,
      warning: 'plaintext-v1 is for loopback development only'
    })),
    startChatgptAccountLogin: jest.fn(async () => ({
      providerId: 'provider_chatgpt',
      status: 'waiting' as const
    })),
    chatgptAccountLoginStatus: jest.fn(async () => ({
      providerId: 'provider_chatgpt',
      status: 'waiting' as const
    })),
    deleteProviderCredential: jest.fn(async () => undefined),
    updateProviderCredentialRouting: jest.fn(async () => undefined),
    refreshProviderCredentialUsage: jest.fn(async () => undefined),
    setProviderAccountStrategy: jest.fn(async () => undefined),
    setProviderInternalBudget: jest.fn(async () => undefined),
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

function bootstrap(
  route: ManagementRoute = 'account',
  origin = window.location.origin,
  surface?: 'embedded' | 'browser'
) {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin,
    data: {
      type: 'ai-editor-management-bootstrap',
      version: 1,
      ...(surface ? { surface } : {}),
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
    ['user', false, false, false],
    ['level2', true, true, false],
    ['level1', true, true, true]
  ] as const)('renders server-authorized navigation for %s', async (
    role,
    seesOrganization,
    seesAudit,
    seesProviders
  ) => {
    render(<App client={clientFor(role)} />)
    bootstrap()
    await screen.findByRole('navigation', { name: '管理导航' })
    expect(Boolean(screen.queryByRole('button', { name: '组织与用户' })))
      .toBe(seesOrganization)
    expect(Boolean(screen.queryByRole('button', { name: '调用审计' })))
      .toBe(seesAudit)
    expect(Boolean(screen.queryByRole('button', { name: 'Provider 与模型' })))
      .toBe(seesProviders)
  })

  it('keeps the management shell and compacts only the embedded Provider page', async () => {
    const api = clientFor('level1')
    api.providers = jest.fn(async (): Promise<ProviderListResponse> => ({
      warning: null,
      accountPool: {
        strategy: 'headroom' as const,
        accounts: [],
        queueDepth: 0,
        recentRouteDecisions: []
      },
      providers: [{
        id: 'provider_chatgpt',
        kind: 'chatgpt',
        displayName: 'ChatGPT 订阅池',
        status: 'active',
        config: {},
        version: 1,
        updatedAt: '2026-07-21T00:00:00.000Z',
        plaintextWarning: null,
        credentials: [{
          id: 'credential_chatgpt',
          maskedPreview: '***',
          storageFormat: 'envelope-v1',
          updatedAt: '2026-07-21T00:00:00.000Z',
          lastUsedAt: null,
          label: 'ChatGPT ???',
          accountIdPreview: 'b2cc85…8693',
          planType: 'ChatGPT 订阅（试验通道）',
          status: 'auth_error',
          routing: {
            enabled: true,
            weight: 1,
            lowQuotaThreshold: 10,
            dailyRequestLimit: 0,
            dailyTokenLimit: 0,
            reservedModels: []
          },
          quota: {
            source: 'provider',
            primary: { usedPercent: 20, remainingPercent: 80, resetsAt: null, windowMinutes: 300 },
            secondary: { usedPercent: 30, remainingPercent: 70, resetsAt: null, windowMinutes: 10080 },
            updatedAt: '2026-07-21T00:00:00.000Z',
            syncStatus: 'ready',
            syncError: null
          },
          runtime: {
            activeRequests: 0,
            concurrencyLimit: 1,
            cooldownUntil: null,
            modelCooldowns: 0
          },
          health: {
            requests: 0,
            successRate: null,
            p95LatencyMs: 0,
            rateLimited: 0,
            lastRequestAt: null,
            lastErrorType: 'token_refresh',
            lastErrorMessage: null
          }
        }]
      }]
    }))

    render(<App client={api} />)
    bootstrap('providers', window.location.origin, 'embedded')

    expect(await screen.findByRole('navigation', { name: '管理导航' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Provider 与模型' })).toBeInTheDocument()
    expect(screen.getByText('ChatGPT 订阅池')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('ChatGPT ???')
    expect(screen.getByText('短周期')).toHaveTextContent('80%')
    expect(screen.getByRole('link', { name: '在浏览器打开完整 Provider 管理' }))
      .toHaveAttribute(
        'href',
        'ai-editor-code://open-full-management?route=providers'
      )

    fireEvent.click(screen.getByRole('button', { name: '关闭路由' }))
    await waitFor(() => {
      expect(api.updateProviderCredentialRouting).toHaveBeenCalledWith(
        'provider_chatgpt',
        'credential_chatgpt',
        {
          label: 'ChatGPT 订阅池',
          routingEnabled: false
        }
      )
    })
  })

  it('exchanges a fragment-only browser ticket and renders the full management page', async () => {
    window.history.replaceState(
      null,
      '',
      '/#browser?ticket=browser-one-time-ticket&route=providers'
    )
    try {
      render(<App client={clientFor('level1')} />)
      expect(await screen.findByRole('navigation', { name: '管理导航' }))
        .toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Provider 与模型' }))
        .toHaveAttribute('aria-current', 'page')
      expect(window.location.hash).toBe('')
      expect(document.body.textContent).not.toContain('browser-one-time-ticket')
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('opens only the password page before loading privileged Level 1 data', async () => {
    const client = {
      ...clientFor('level1'),
      account: jest.fn(async () => ({
        ...account,
        account: {
          ...account.account,
          role: 'level1' as const,
          mustChangePassword: true
        }
      }))
    }
    render(<App client={client} />)
    bootstrap('security')

    expect(await screen.findByRole('heading', { name: '修改密码' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设备与安全' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.queryByRole('button', { name: 'Provider 与模型' }))
      .not.toBeInTheDocument()
    expect(client.organizations).not.toHaveBeenCalled()
    expect(client.organizationAccounts).not.toHaveBeenCalled()
    expect(client.invitations).not.toHaveBeenCalled()
    expect(client.publicMvpCapacity).not.toHaveBeenCalled()
    expect(client.providers).not.toHaveBeenCalled()
    expect(client.models).not.toHaveBeenCalled()
    expect(client.diagnostics).not.toHaveBeenCalled()
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

  it('shows Level 1 as unlimited and exposes organization and allocation shortcuts', async () => {
    render(<App client={clientFor('level1')} />)
    bootstrap()

    expect(await screen.findByText(/一级管理员账号额度不受限/)).toBeInTheDocument()
    expect(screen.queryByText('87.500000')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '管理组织与用户' }))
    expect(await screen.findByRole('heading', { name: '组织与用户' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '我的账号' }))
    fireEvent.click(screen.getByRole('button', { name: '分配组织额度' }))
    expect(await screen.findByRole('heading', { name: '示例组织' })).toBeInTheDocument()
    expect(screen.getByLabelText('组织月度总积分')).toBeInTheDocument()
    expect(screen.getByLabelText('用户积分 member@example.test')).toBeInTheDocument()
  })

  it('shows organization users and invitations only for an authorized administrator', async () => {
    render(<App client={clientFor('level2')} />)
    bootstrap('organization')
    expect(await screen.findByText('member@example.test')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '创建组织' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '邀请码' }))
    expect(await screen.findByText(/2\/10/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成邀请码' })).toBeInTheDocument()
  })

  it('shows the Level-1-only public MVP account capacity on the invitation page', async () => {
    const client = clientFor('level1')
    render(<App client={client} />)
    bootstrap('invitations')

    expect(await screen.findByText('公网 MVP 账号容量：1 / 30')).toBeInTheDocument()
    expect(screen.getByText(/剩余 29 个名额/)).toBeInTheDocument()
    expect(client.publicMvpCapacity).toHaveBeenCalledTimes(1)
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

    expect(await screen.findByRole('alertdialog', { name: '密码修改失败' }))
      .toHaveTextContent('密码未被修改')
  })

  it('loads Provider and redacted diagnostics only for a Level-1 session', async () => {
    const client = clientFor('level1')
    render(<App client={client} />)
    bootstrap('providers')

    expect(await screen.findByRole('heading', { name: 'Local Relay' })).toBeInTheDocument()
    expect(screen.getByText(/sk-\.\.\.abcd/)).toBeInTheDocument()
    expect(screen.getByText(/plaintext-v1 is for loopback/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('diagnostic-secret')

    fireEvent.click(screen.getByRole('button', { name: '系统诊断' }))
    expect(await screen.findByText(/REDACTED/)).toBeInTheDocument()
    expect(screen.getByText(/closed/)).toBeInTheDocument()
  })
})
