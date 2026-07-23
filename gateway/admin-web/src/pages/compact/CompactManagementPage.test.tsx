import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ManagementRequestError, type ManagementApiClient } from '../../app/api-client'
import type { ProviderListResponse } from '../../app/types'
import { CompactManagementPage } from './CompactManagementPage'

const providers = {
  providers: [{
    id: 'provider_chatgpt',
    kind: 'chatgpt',
    displayName: 'ChatGPT 订阅账号',
    status: 'healthy',
    credentials: [{
      id: 'credential_chatgpt',
      label: 'ChatGPT 订阅账号',
      accountIdPreview: 'acct…1234',
      status: 'active',
      routing: { enabled: true },
      quota: {
        primary: { remainingPercent: 80 },
        secondary: { remainingPercent: 20 }
      }
    }]
  }]
} as unknown as ProviderListResponse

describe('CompactManagementPage', () => {
  it('clears a stale provider error when fresh provider data arrives', async () => {
    const refreshUsage = jest.fn(async () => {
      throw new ManagementRequestError(
        503,
        'provider_worker_unavailable',
        '境外模型通道暂时不可用，请稍后重试。',
        true,
        'req_test',
        true
      )
    })
    const client = {
      refreshProviderCredentialUsage: refreshUsage
    } as unknown as ManagementApiClient
    const onRefresh = jest.fn(async () => undefined)
    const { rerender } = render(
      <CompactManagementPage
        client={client}
        providers={providers}
        fullRoute="providers"
        onRefresh={onRefresh}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        '境外模型通道暂时不可用，请稍后重试。'
      )
    })

    rerender(
      <CompactManagementPage
        client={client}
        providers={{ ...providers } as ProviderListResponse}
        fullRoute="providers"
        onRefresh={onRefresh}
      />
    )
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })
})
