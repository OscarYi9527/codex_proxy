import type { FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { ProviderRouteAdapter } from './standalone-route-adapter.js'
import { RequestPreflight } from './request-preflight.js'

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
    private readonly adapter: ProviderRouteAdapter
  ) {}

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'responses' | 'chat-completions' = 'responses'
  ): Promise<void> {
    const body = requestBody(request.body)
    await this.preflight.verify(request, body)
    // The standalone compatibility response is decoupled from the local
    // socket close so upstream completion can reconcile usage in later
    // settlement hooks instead of being silently abandoned.
    if (kind === 'chat-completions') {
      if (!this.adapter.forwardChatCompletions) {
        throw new SafeError({
          code: 'provider_unavailable',
          message: '当前模型不支持 Chat Completions 兼容接口。',
          statusCode: 409
        })
      }
      await this.adapter.forwardChatCompletions(request, reply, body)
      return
    }
    await this.adapter.forwardResponses(request, reply, body)
  }
}
