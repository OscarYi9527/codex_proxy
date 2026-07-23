import {
  filterGatewayModels,
  type ProviderRouteAdapter,
  type SafeModel
} from '../../src/routing/standalone-route-adapter.js'
import { ModelCatalog } from '../../src/routing/model-catalog.js'

const model = (id: string): SafeModel => ({
  id,
  object: 'model',
  owned_by: 'test'
})

describe('AI Editor Gateway model catalog', () => {
  it('hides built-in auto aliases that were not explicitly configured', () => {
    const models = filterGatewayModels([
      model('auto'),
      model('auto-fast'),
      model('auto-cheap'),
      model('auto-reliable'),
      model('deepseek-v4-pro'),
      model('openai-api-gpt-5.6-sol')
    ], [], {
      deepseek: true,
      'openai-api': true
    })

    expect(models.map(item => item.id)).toEqual([
      'deepseek-v4-pro',
      'openai-api-gpt-5.6-sol'
    ])
  })

  it('exposes subscription models only when the ChatGPT Provider is ready', () => {
    const catalog = [
      model('gpt-5.6-sol'),
      model('deepseek-v4-pro')
    ]

    expect(filterGatewayModels(catalog, [], {
      deepseek: true,
      'chatgpt-sub': false
    }).map(item => item.id)).toEqual(['deepseek-v4-pro'])

    expect(filterGatewayModels(catalog, [], {
      deepseek: true,
      'chatgpt-sub': true
    }).map(item => item.id)).toEqual([
      'gpt-5.6-sol',
      'deepseek-v4-pro'
    ])
  })

  it('allows a virtual route only after explicit Gateway configuration', () => {
    expect(filterGatewayModels([
      model('auto'),
      model('auto'),
      model('deepseek-v4-pro')
    ], ['auto'], {
      deepseek: true
    }).map(item => item.id)).toEqual([
      'auto',
      'deepseek-v4-pro'
    ])
  })

  it('keeps account status independent from a transient Worker catalog failure', async () => {
    let fail = false
    const adapter = {
      listModels: async () => {
        if (fail) throw new Error('temporary worker timeout')
        return {
          object: 'list' as const,
          data: [model('gpt-5.6-terra')]
        }
      }
    } as ProviderRouteAdapter
    const catalog = new ModelCatalog(adapter)

    await expect(catalog.currentModel()).resolves.toBe('gpt-5.6-terra')
    fail = true
    await expect(catalog.currentModel()).resolves.toBe('gpt-5.6-terra')
  })

  it('omits the informational current model when the first Worker probe fails', async () => {
    const catalog = new ModelCatalog({
      listModels: async () => {
        throw new Error('temporary worker timeout')
      }
    } as ProviderRouteAdapter)

    await expect(catalog.currentModel()).resolves.toBeNull()
  })
})
