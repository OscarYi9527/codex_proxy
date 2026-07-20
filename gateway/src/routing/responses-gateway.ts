import type { FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { ProviderRouteAdapter } from './standalone-route-adapter.js'
import { RequestPreflight } from './request-preflight.js'
import { TurnRiskService } from '../credits/turn-risk-service.js'
import { SettlementService } from '../credits/settlement-service.js'
import type { AuditService } from '../audit/audit-service.js'
import type { ProviderForwardResult } from './standalone-route-adapter.js'
import type { SafeLogger } from '../common/logging.js'

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
    private readonly settlements?: SettlementService,
    private readonly audit?: AuditService,
    private readonly logger?: SafeLogger
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
    const complete = async (resultValue: void | ProviderForwardResult): Promise<void> => {
      const result = resultValue || {}
      const usage = reservation && !result.deferSettlement
        ? await this.settlements?.settle(verified.turnId, result)
        : null
      if (usage && this.adapter.acknowledgeSettlement) {
        try {
          await this.adapter.acknowledgeSettlement(result, usage)
        } catch (error) {
          // The persistent Worker outbox remains pending and the background
          // reconciler retries without repeating the upstream Turn.
          this.logger?.warn('provider_worker_settlement_ack_deferred', {
            turnId: verified.turnId,
            error
          })
        }
      }
      const inputTokens = usage?.inputTokens ?? result.usage?.inputTokens
      const outputTokens = usage?.outputTokens ?? result.usage?.outputTokens
      await this.audit?.recordConversation({
        identity: verified.identity,
        turnId: verified.turnId,
        modelId: verified.modelId,
        requestBody: body,
        ...(result.assistantText ? { assistantText: result.assistantText } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {})
      })
    }
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
        await complete(result)
        return
      }
      const result = await this.adapter.forwardResponses(request, reply, body)
      await complete(result)
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
