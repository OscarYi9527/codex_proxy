import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    providers: async () => ({ warning: null, providers: [] }),
    createProvider: async () => { throw new Error('not used') },
    updateProvider: async () => { throw new Error('not used') },
    deleteProvider: async () => undefined,
    addProviderCredential:
      jest.fn<ManagementApiClient['addProviderCredential']>(async () => undefined),
    deleteProviderCredential: async () => undefined,
    startChatgptLogin: async () => ({ status: 'waiting' }),
    chatgptLoginStatus: async () => ({ status: 'waiting' }),
    models: async () => ({ models: [] }),
    putModel: async () => undefined,
    diagnostics: async () => ({})
  }
}

const providers = {
  warning: 'plaintext-v1 仅允许用于回环开发环境',
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
      lastUsedAt: null
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
  })

  it('starts official login only from a ChatGPT Provider and renders the safe URL', async () => {
    const api = client()
    api.startChatgptLogin = jest.fn<
      ManagementApiClient['startChatgptLogin']
    >(async () => ({
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

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI 官方登录' }))
    expect(await screen.findByText('请完成 OpenAI 官方登录')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '在浏览器中打开 OpenAI 登录' }))
      .toHaveAttribute('href', 'https://auth.openai.com/authorize')
    expect(api.startChatgptLogin).toHaveBeenCalledWith('provider_test')
  })
})
