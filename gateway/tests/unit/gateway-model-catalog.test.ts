import {
  filterGatewayModels,
  type SafeModel
} from '../../src/routing/standalone-route-adapter.js'

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
})
