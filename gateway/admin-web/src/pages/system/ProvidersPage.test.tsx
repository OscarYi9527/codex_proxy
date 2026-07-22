import { jest } from '@jest/globals'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ManagementApiClient } from '../../app/api-client'
import type { ProviderListResponse } from '../../app/types'
import { ProvidersPage } from './ProvidersPage'

function client(): ManagementApiClient {
  return {
    exchangeTicket: async () => { throw new Error('not used') },
    account: async () => { throw new Error('not used') },
    devices: async () => [],
    changePassword: async () => undefined,
    revokeDevice: async () => undefined,
    usage: async () => { throw new Error('not used') },
    publicMvpCapacity: async () => { throw new Error('not used') },
    organizations: async () => [],
    createOrganization: async () => { throw new Error('not used') },
    organizationAccounts: async () => [],
    setAccountStatus: async () => undefined,
    setAccountRole: async () => { throw new Error('not used') },
    invitations: async () => [],
    createInvitation: async () => { throw new Error('not used') },
    revokeInvitation: async () => undefined,
    organizationCredits: async () => { throw new Error('not used') },
    setMonthlyCredits: async () => undefined,
    setUserCreditAllocation: async () => undefined,
    setRiskPolicy: async () => undefined,
    conversationAudits: async () => ({ conversations: [] }),
    conversationAudit: async () => { throw new Error('not used') },
    adminAuditEvents: async () => ({ events: [] }),
    setAuditRetention: async () => undefined,
    providers: async () => providers,
    createProvider: async () => { throw new Error('not used') },
    updateProvider: async () => { throw new Error('not used') },
    deleteProvider: async () => undefined,
    addProviderCredential: async () => undefined,
    importChatgptAccount:
      jest.fn<ManagementApiClient['importChatgptAccount']>(async input => ({
        providerId: 'provider_chatgpt',
        credentialId: 'credential_chatgpt',
        accountIdPreview: 'acct…test',
        created: true,
        routingEnabled: input.routingEnabled,
        warning: 'plaintext-v1 仅允许用于回环开发环境'
      })),
    startChatgptAccountLogin:
      jest.fn<ManagementApiClient['startChatgptAccountLogin']>(async () => ({
        providerId: 'provider_chatgpt',
        id: 'oauth_test',
        status: 'waiting',
        message: '请输入一次性代码',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH'
      })),
    chatgptAccountLoginStatus:
      jest.fn<ManagementApiClient['chatgptAccountLoginStatus']>(async () => ({
        providerId: 'provider_chatgpt',
        status: 'waiting'
      })),
    deleteProviderCredential:
      jest.fn<ManagementApiClient['deleteProviderCredential']>(async () => undefined),
    updateProviderCredentialRouting:
      jest.fn<ManagementApiClient['updateProviderCredentialRouting']>(async () => undefined),
    refreshProviderCredentialUsage:
      jest.fn<ManagementApiClient['refreshProviderCredentialUsage']>(async () => undefined),
    setProviderAccountStrategy:
      jest.fn<ManagementApiClient['setProviderAccountStrategy']>(async () => undefined),
    setProviderInternalBudget: async () => undefined,
    startChatgptLogin: async () => ({ status: 'waiting' }),
    chatgptLoginStatus: async () => ({ status: 'waiting' }),
    models: async () => ({ models: [] }),
    putModel: async () => undefined,
    diagnostics: async () => ({})
  }
}

const providers: ProviderListResponse = {
  warning: 'plaintext-v1 仅允许用于回环开发环境',
  accountPool: {
    strategy: 'headroom',
    accounts: [],
    queueDepth: 2,
    recentRouteDecisions: []
  },
  providers: [{
    id: 'provider_chatgpt',
    kind: 'chatgpt',
    displayName: 'ChatGPT 订阅池',
    status: 'active',
    config: { models: ['gpt-5.4'] },
    version: 1,
    updatedAt: '2026-07-22T01:00:00.000Z',
    plaintextWarning: null,
    credentials: [{
      id: 'credential_chatgpt',
      maskedPreview: 'chatgpt-...abcd',
      storageFormat: 'plaintext-v1',
      updatedAt: '2026-07-22T01:00:00.000Z',
      lastUsedAt: null,
      label: '订阅账号 A',
      accountIdPreview: 'acct-a…123456',
      planType: 'plus',
      status: 'active',
      routing: {
        enabled: true,
        weight: 6,
        lowQuotaThreshold: 12,
        dailyRequestLimit: 100,
        dailyTokenLimit: 500000,
        reservedModels: ['gpt-5.4']
      },
      quota: {
        source: 'provider',
        primary: {
          usedPercent: 25,
          remainingPercent: 75,
          resetsAt: 1_800_000_000,
          windowMinutes: 300
        },
        secondary: null,
        updatedAt: '2026-07-22T01:00:00.000Z',
        syncStatus: 'synced',
        syncError: null
      },
      runtime: {
        activeRequests: 0,
        concurrencyLimit: 3,
        cooldownUntil: null,
        modelCooldowns: 0
      },
      health: {
        requests: 12,
        successRate: 91.7,
        p95LatencyMs: 820,
        rateLimited: 1,
        lastRequestAt: '2026-07-22T01:00:00.000Z',
        lastErrorType: null,
        lastErrorMessage: null
      }
    }]
  }, {
    id: 'provider_relay',
    kind: 'relay',
    displayName: '不应显示的 Relay',
    status: 'active',
    config: { models: ['relay-model'] },
    version: 1,
    updatedAt: '2026-07-22T01:00:00.000Z',
    plaintextWarning: null,
    credentials: []
  }]
}

describe('subscription-only account management page', () => {
  it('shows only subscription accounts, quota, routing and removal controls', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={{ models: [{ id: 'hidden', publicModelId: 'hidden-model', providerId: 'provider_relay', upstreamModelId: 'hidden-model', priority: 1, enabled: true }] }}
        onRefresh={refresh}
      />
    )

    expect(screen.getByRole('heading', { name: '订阅账号管理' })).toBeInTheDocument()
    expect(screen.getByText('订阅账号 A')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText(/等待队列/).nextSibling?.textContent).toBe('2')
    expect(document.body.textContent).not.toContain('不应显示的 Relay')
    expect(document.body.textContent).not.toContain('新增 Provider')
    expect(document.body.textContent).not.toContain('模型路由')
    expect(document.body.textContent).not.toContain('Base URL')
    expect(document.body.textContent).not.toContain('内部预算')

    fireEvent.change(screen.getByLabelText('路由权重'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(api.updateProviderCredentialRouting).toHaveBeenCalledWith(
        'provider_chatgpt',
        'credential_chatgpt',
        {
          label: '订阅账号 A',
          routingEnabled: true,
          routingWeight: 9
        }
      )
    })
  })

  it('starts official device login and renders the safe code and OpenAI link', async () => {
    const api = client()
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={{ models: [] }}
        onRefresh={async () => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }))
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 官方登录/ }))

    expect(await screen.findByText(/ABCD-EFGH/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开 OpenAI 登录页' }))
      .toHaveAttribute('href', 'https://auth.openai.com/codex/device')
    expect(api.startChatgptAccountLogin).toHaveBeenCalledWith({
      label: '',
      routingEnabled: true
    })
  })

  it('imports auth.json and makes duplicate updates explicit', async () => {
    const api = client()
    api.importChatgptAccount = jest.fn<
      ManagementApiClient['importChatgptAccount']
    >(async () => ({
      providerId: 'provider_chatgpt',
      credentialId: 'credential_chatgpt',
      accountIdPreview: 'acct-a…123456',
      created: false,
      routingEnabled: true,
      warning: ''
    }))
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={{ models: [] }}
        onRefresh={async () => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }))
    const authJson = JSON.stringify({
      tokens: {
        access_token: 'pasted-access-secret',
        refresh_token: 'pasted-refresh-secret',
        account_id: 'pasted-account-id'
      }
    })
    fireEvent.change(screen.getByLabelText('auth.json 内容'), {
      target: { value: authJson }
    })
    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))

    await waitFor(() => {
      expect(api.importChatgptAccount).toHaveBeenCalledWith({
        authJson,
        label: '',
        routingEnabled: true
      })
    })
    expect(await screen.findByText(/不会重复创建账号卡片/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('pasted-access-secret')
  })

  it('imports only the trusted Code bridge response', async () => {
    const api = client()
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={{ models: [] }}
        onRefresh={async () => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }))
    fireEvent.click(screen.getByRole('button', { name: /一键导入当前 Codex 账号/ }))
    expect((click.mock.contexts[0] as HTMLAnchorElement).href)
      .toBe('ai-editor-code://import-current-codex-account')

    const authJson = JSON.stringify({
      tokens: {
        access_token: 'native-access-secret',
        refresh_token: 'native-refresh-secret',
        account_id: 'native-account-id'
      }
    })
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: 'https://untrusted.example',
        data: { type: 'ai-editor-current-codex-auth', version: 1, authJson }
      }))
    })
    expect(api.importChatgptAccount).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { type: 'ai-editor-current-codex-auth', version: 1, authJson }
      }))
    })
    await waitFor(() => {
      expect(api.importChatgptAccount).toHaveBeenCalled()
    })
    expect(document.body.textContent).not.toContain('native-access-secret')
    click.mockRestore()
  })

  it('never displays the historical mojibake account name', () => {
    const broken: ProviderListResponse = {
      ...providers,
      providers: [{
        ...providers.providers[0],
        displayName: 'ChatGPT ???',
        credentials: [{
          ...providers.providers[0].credentials[0],
          label: 'ChatGPT ???'
        }]
      }]
    }
    render(
      <ProvidersPage
        client={client()}
        providers={broken}
        models={{ models: [] }}
        onRefresh={async () => undefined}
      />
    )
    expect(screen.getByText('ChatGPT 订阅账号')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('ChatGPT ???')
  })
})
