import type { FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import { TokenService } from '../auth/token-service.js'
import type { AccessIdentity } from '../auth/types.js'
import { ModelCatalog } from './model-catalog.js'

export interface GatewayRequestIdentity {
  readonly identity: AccessIdentity
  readonly turnId: string
  readonly modelId: string
}

export class RequestPreflight {
  constructor(
    private readonly tokens: TokenService,
    private readonly models: ModelCatalog
  ) {}

  async verify(request: FastifyRequest, body: Record<string, unknown>): Promise<GatewayRequestIdentity> {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '')
    if (!match?.[1]) throw this.loginRequired()
    const identity = await this.tokens.authenticateAccessToken(match[1])
    const sessionHeader = request.headers['x-ai-editor-device-session']
    if (sessionHeader !== identity.deviceSessionId) throw this.loginRequired()
    const turnId = String(request.headers['x-ai-editor-turn-id'] || '')
    if (!/^turn_[A-Za-z0-9_-]{8,120}$/.test(turnId)) {
      throw new SafeError({
        code: 'invalid_turn_id',
        message: '请求缺少有效 Turn ID。',
        statusCode: 400
      })
    }
    const modelId = typeof body.model === 'string' ? body.model : ''
    if (!modelId) {
      throw new SafeError({
        code: 'invalid_model',
        message: '请求缺少模型。',
        statusCode: 400
      })
    }
    await this.models.requireModel(modelId)
    return { identity, turnId, modelId }
  }

  private loginRequired(): SafeError {
    return new SafeError({
      code: 'login_required',
      message: '需要登录 AI Editor 产品账号。',
      statusCode: 401
    })
  }
}
