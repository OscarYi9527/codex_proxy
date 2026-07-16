import { SafeError } from '../common/errors.js'
import type {
  ProviderRouteAdapter,
  SafeModel,
  SafeModelList
} from './standalone-route-adapter.js'

export class ModelCatalog {
  constructor(private readonly adapter: ProviderRouteAdapter) {}

  async list(): Promise<SafeModelList> {
    const upstream = await this.adapter.listModels()
    const data = upstream.data
      .filter(model =>
        typeof model.id === 'string' &&
        model.id.length > 0 &&
        model.id !== 'gpt-mock'
      )
      .map<SafeModel>(model => ({
        id: model.id,
        object: 'model',
        owned_by: 'ai-editor'
      }))
    return { object: 'list', data }
  }

  async requireModel(modelId: string): Promise<SafeModel> {
    const models = await this.list()
    const model = models.data.find(candidate => candidate.id === modelId)
    if (!model) {
      throw new SafeError({
        code: 'provider_unavailable',
        message: '当前模型没有可用的安全路由。',
        statusCode: 409,
        retryable: true
      })
    }
    return model
  }

  async currentModel(): Promise<string | null> {
    return (await this.list()).data[0]?.id || null
  }
}
