import { jest } from '@jest/globals'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ManagementApiClient } from '../../app/api-client'
import { ProvidersPage } from './ProvidersPage'

function client(): ManagementApiClient {
  return {
    exchangeTicket: async () => { throw new Error('not used') },
    account: async () => { throw new Error('not used') },
    devices: async () => [],
    changePassword: async () => undefined,
    revokeDevice: async () => undefined,
    usage: async () => { throw new Error('not used') },
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
    providers: async () => ({
      warning: null,
      accountPool: {
        strategy: 'headroom',
        accounts: [],
        queueDepth: 0,
        recentRouteDecisions: []
      },
      providers: []
    }),
    createProvider: async () => { throw new Error('not used') },
    updateProvider: async () => { throw new Error('not used') },
    deleteProvider: async () => undefined,
    addProviderCredential:
      jest.fn<ManagementApiClient['addProviderCredential']>(async () => undefined),
    importChatgptAccount:
      jest.fn<ManagementApiClient['importChatgptAccount']>(async input => ({
        providerId: 'provider_chatgpt',
        credentialId: 'credential_chatgpt',
        accountIdPreview: 'account…test',
        created: true,
        routingEnabled: input.routingEnabled,
        warning: 'plaintext-v1 仅允许用于回环开发环境'
      })),
    startChatgptAccountLogin:
      jest.fn<ManagementApiClient['startChatgptAccountLogin']>(async () => ({
        providerId: 'provider_chatgpt',
        status: 'waiting'
      })),
    chatgptAccountLoginStatus:
      jest.fn<ManagementApiClient['chatgptAccountLoginStatus']>(async () => ({
        providerId: 'provider_chatgpt',
        status: 'waiting'
      })),
    deleteProviderCredential: async () => undefined,
    updateProviderCredentialRouting:
      jest.fn<ManagementApiClient['updateProviderCredentialRouting']>(async () => undefined),
    refreshProviderCredentialUsage:
      jest.fn<ManagementApiClient['refreshProviderCredentialUsage']>(async () => undefined),
    setProviderAccountStrategy:
      jest.fn<ManagementApiClient['setProviderAccountStrategy']>(async () => undefined),
    setProviderInternalBudget:
      jest.fn<ManagementApiClient['setProviderInternalBudget']>(async () => undefined),
    startChatgptLogin: async () => ({ status: 'waiting' }),
    chatgptLoginStatus: async () => ({ status: 'waiting' }),
    models: async () => ({ models: [] }),
    putModel: async () => undefined,
    diagnostics: async () => ({})
  }
}

const providers = {
  warning: 'plaintext-v1 仅允许用于回环开发环境',
  accountPool: {
    strategy: 'headroom' as const,
    accounts: [],
    queueDepth: 0,
    recentRouteDecisions: []
  },
  providers: [{
    id: 'provider_test',
    kind: 'relay' as const,
    displayName: '安全 Relay',
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
    plaintextWarning: 'plaintext-v1 仅允许用于回环开发环境'
  }]
}

const models = {
  models: [{
    id: 'route_test',
    publicModelId: 'relay-provider_test-gpt-5.4-mini',
    providerId: 'provider_test',
    upstreamModelId: 'gpt-5.4-mini',
    priority: 1,
    enabled: true
  }]
}

describe('Level-1 Provider administration page (T083/T088)', () => {
  it('shows only masked credentials and keeps a submitted secret out of the DOM', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={models}
        onRefresh={refresh}
      />
    )

    expect(screen.getByText(/sk-\.\.\.abcd/)).toBeInTheDocument()
    expect(screen.getByText(/plaintext-v1 仅允许/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('sk-live-unmasked-secret')

    const secret = screen.getByLabelText('新凭据') as HTMLInputElement
    fireEvent.change(secret, { target: { value: 'sk-live-unmasked-secret' } })
    fireEvent.submit(secret.closest('form') as HTMLFormElement)

    await waitFor(() => {
      expect(api.addProviderCredential).toHaveBeenCalledWith(
        'provider_test',
        'sk-live-unmasked-secret'
      )
    })
    expect(secret.value).toBe('')
    expect(document.body.textContent).not.toContain('sk-live-unmasked-secret')
    expect(refresh).toHaveBeenCalledTimes(1)

    const budgetInput = screen.getByLabelText('内部预算（积分）')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存预算' })).not.toBeDisabled()
    })
    fireEvent.change(budgetInput, {
      target: { value: '500.25' }
    })
    fireEvent.submit(budgetInput.closest('form') as HTMLFormElement)
    await waitFor(() => {
      expect(api.setProviderInternalBudget).toHaveBeenCalledWith(
        'provider_test',
        '500.25'
      )
    })
  })

  it('starts official login from the unified shortcut without a pre-created ChatGPT Provider', async () => {
    const api = client()
    api.startChatgptAccountLogin = jest.fn<
      ManagementApiClient['startChatgptAccountLogin']
    >(async () => ({
      providerId: 'provider_chatgpt',
      id: 'oauth_test',
      status: 'waiting',
      message: '请完成 OpenAI 官方登录',
      verificationUrl: 'https://auth.openai.com/authorize'
    }))
    render(
      <ProvidersPage
        client={api}
        providers={{
          warning: null,
          accountPool: providers.accountPool,
          providers: [{
            ...providers.providers[0],
            kind: 'chatgpt',
            displayName: 'Official ChatGPT'
          }]
        }}
        models={{ models: [] }}
        onRefresh={async () => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }))
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 官方登录/ }))
    expect(await screen.findByText('请完成 OpenAI 官方登录')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '在系统浏览器中打开 OpenAI 登录' }))
      .toHaveAttribute('href', 'https://auth.openai.com/authorize')
    expect(api.startChatgptAccountLogin).toHaveBeenCalledWith({
      label: '',
      routingEnabled: false
    })
  })

  it('imports pasted auth.json, applies the chosen routing state and clears the secret', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={models}
        onRefresh={refresh}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }))
    fireEvent.change(screen.getByLabelText('账号名称'), {
      target: { value: '主订阅账号' }
    })
    fireEvent.click(screen.getByLabelText('导入后立即参与自动路由'))
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
        label: '主订阅账号',
        routingEnabled: true
      })
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('pasted-access-secret')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('requests the native Code bridge and imports only a trusted same-origin response', async () => {
    const api = client()
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={models}
        onRefresh={async () => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }))
    fireEvent.click(screen.getByLabelText('导入后立即参与自动路由'))
    fireEvent.click(screen.getByRole('button', { name: /一键导入当前 Codex 账号/ }))
    expect(click).toHaveBeenCalledTimes(1)
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
        data: {
          type: 'ai-editor-current-codex-auth',
          version: 1,
          authJson
        }
      }))
    })
    expect(api.importChatgptAccount).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          type: 'ai-editor-current-codex-auth',
          version: 1,
          authJson
        }
      }))
    })
    await waitFor(() => {
      expect(api.importChatgptAccount).toHaveBeenCalledWith({
        authJson,
        label: '',
        routingEnabled: true
      })
    })
    expect(document.body.textContent).not.toContain('native-access-secret')
    click.mockRestore()
  })

  it('renders real quota/health and persists the existing Proxy account policy', async () => {
    const api = client()
    const account = {
      ...providers.providers[0].credentials[0],
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
        source: 'provider' as const,
        primary: {
          usedPercent: 25,
          remainingPercent: 75,
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
        requests: 12,
        successRate: 91.7,
        p95LatencyMs: 820,
        rateLimited: 1,
        lastRequestAt: '2026-07-17T01:00:00.000Z',
        lastErrorType: null,
        lastErrorMessage: null
      }
    }
    render(
      <ProvidersPage
        client={api}
        providers={{
          warning: null,
          accountPool: {
            strategy: 'headroom',
            accounts: [],
            queueDepth: 2,
            recentRouteDecisions: []
          },
          providers: [{
            ...providers.providers[0],
            kind: 'chatgpt',
            displayName: 'ChatGPT 订阅池',
            credentials: [account]
          }]
        }}
        models={{ models: [] }}
        onRefresh={async () => undefined}
      />
    )

    expect(screen.getByText('订阅账号 A')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('91.7%')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.getByText(/队列 2/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('路由权重'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '保存调度设置' }))
    await waitFor(() => {
      expect(api.updateProviderCredentialRouting).toHaveBeenCalledWith(
        'provider_test',
        'cred_test',
        expect.objectContaining({
          label: '订阅账号 A',
          routingEnabled: true,
          routingWeight: 9,
          lowQuotaThreshold: 12
        })
      )
    })
  })

  it('edits model route priority without exposing Provider credentials', async () => {
    const api = client()
    api.putModel = jest.fn<ManagementApiClient['putModel']>(async () => undefined)
    render(
      <ProvidersPage
        client={api}
        providers={providers}
        models={models}
        onRefresh={async () => undefined}
      />
    )
    const priority = screen.getByLabelText('路由优先级')
    fireEvent.change(priority, { target: { value: '7' } })
    fireEvent.submit(priority.closest('form') as HTMLFormElement)
    await waitFor(() => {
      expect(api.putModel).toHaveBeenCalledWith(
        'relay-provider_test-gpt-5.4-mini',
        {
          providerId: 'provider_test',
          upstreamModelId: 'gpt-5.4-mini',
          priority: 7,
          enabled: true
        }
      )
    })
  })
})
