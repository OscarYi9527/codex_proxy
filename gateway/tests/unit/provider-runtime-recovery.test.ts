import { jest } from '@jest/globals'
import { ProviderService } from '../../src/providers/provider-service.js'
import type {
  GatewayProviderRuntimeConfiguration,
  ProviderRouteAdapter
} from '../../src/routing/standalone-route-adapter.js'

describe('Provider Worker runtime recovery', () => {
  it('reapplies persisted ChatGPT configuration only after an empty Worker restart', async () => {
    const provider = {
      id: 'provider_chatgpt',
      kind: 'chatgpt' as const,
      displayName: 'ChatGPT subscription',
      status: 'active' as const,
      config: { models: ['gpt-5.4-mini'] },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      version: 1
    }
    const credential = {
      id: 'credential_chatgpt',
      providerId: provider.id,
      storageKind: 'envelope-v1' as const,
      secretPayload: JSON.stringify({
        account_id: 'upstream-account',
        refresh_token: 'refresh-token'
      }),
      keyVersion: 'test',
      credentialVersion: 1,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt
    }
    const route = {
      id: 'route_chatgpt',
      publicModelId: 'gpt-5.4-mini',
      providerId: provider.id,
      upstreamModelId: 'gpt-5.4-mini',
      priority: 1,
      enabled: true,
      policy: {},
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      version: 1
    }
    const repository = {
      listProviders: jest.fn(async () => [provider]),
      listCredentials: jest.fn(async () => [credential]),
      listModelRoutes: jest.fn(async () => [route])
    }
    const configurations: GatewayProviderRuntimeConfiguration[] = []
    const adapter = {
      listModels: jest.fn(),
      forwardResponses: jest.fn(),
      providerRuntimeStatus: jest.fn(async () => ({
        enabled: false,
        accountCount: 0,
        modelCount: 0
      })),
      configureProviders: jest.fn(async value => {
        configurations.push(value)
      })
    } as unknown as ProviderRouteAdapter
    const service = new ProviderService(
      repository as never,
      adapter,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )

    await expect(service.recoverWorkerRuntimeConfiguration()).resolves.toBe(true)
    expect(configurations).toHaveLength(1)
    expect(configurations[0]).toMatchObject({
      modelIds: ['gpt-5.4-mini'],
      chatgptAccounts: [{
        id: credential.id,
        account_id: 'upstream-account',
        refresh_token: 'refresh-token'
      }]
    })

    jest.mocked(adapter.providerRuntimeStatus!).mockResolvedValue({
      enabled: true,
      accountCount: 1,
      modelCount: 1
    })
    await expect(service.recoverWorkerRuntimeConfiguration()).resolves.toBe(false)
    expect(configurations).toHaveLength(1)
  })
})
