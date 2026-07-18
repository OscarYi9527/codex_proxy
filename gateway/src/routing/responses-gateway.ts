import type { FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { ProviderRouteAdapter } from './standalone-route-adapter.js'
import { RequestPreflight } from './request-preflight.js'
import { TurnRiskService } from '../credits/turn-risk-service.js'
import { SettlementService } from '../credits/settlement-service.js'

function requestBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError({
      code: 'invalid_request',
      message: 'Responses 请求正文无效。',
      statusCode: 400
    })
  }
  return value as Record<string, unknown>
}

export class ResponsesGateway {
  constructor(
    private readonly preflight: RequestPreflight,
    private readonly adapter: ProviderRouteAdapter,
    private readonly risks?: TurnRiskService,
    private readonly settlements?: SettlementService
  ) {}

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'responses' | 'chat-completions' = 'responses'
  ): Promise<void> {
    const body = requestBody(request.body)
    const verified = await this.preflight.verify(request, body)
    const reservation = this.risks
      ? await this.risks.reserve({
          identity: verified.identity,
          turnId: verified.turnId,
          modelId: verified.modelId,
          body
        })
      : null
    // The standalone compatibility response is decoupled from the local
    // socket close so upstream completion can reconcile usage in later
    // settlement hooks instead of being silently abandoned.
    try {
      if (reservation) await this.risks?.markStreaming(verified.turnId)
      if (kind === 'chat-completions') {
        if (!this.adapter.forwardChatCompletions) {
          throw new SafeError({
            code: 'provider_unavailable',
            message: '当前模型不支持 Chat Completions 兼容接口。',
            statusCode: 409
          })
        }
        const result = await this.adapter.forwardChatCompletions(request, reply, body)
        if (reservation) await this.settlements?.settle(verified.turnId, result || {})
        return
      }
      const result = await this.adapter.forwardResponses(request, reply, body)
      if (reservation) await this.settlements?.settle(verified.turnId, result || {})
    } catch (error) {
      if (reservation) {
        await this.risks?.fail(
          verified.turnId,
          error instanceof SafeError ? error.code : 'provider_request_failed'
        )
      }
      throw error
    }
  }
}
