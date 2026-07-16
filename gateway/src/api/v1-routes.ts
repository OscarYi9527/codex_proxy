import type { FastifyInstance } from 'fastify'
import type { AccessTokenVerifier } from './middleware/authentication.js'
import { requireAccessToken } from './middleware/authentication.js'
import { ModelCatalog } from '../routing/model-catalog.js'
import { ResponsesGateway } from '../routing/responses-gateway.js'

export function registerV1Routes(app: FastifyInstance, options: {
  verifier: AccessTokenVerifier
  models: ModelCatalog
  responses: ResponsesGateway
}): void {
  const authenticate = requireAccessToken(options.verifier)
  app.get('/v1/models', { preHandler: authenticate }, async () => options.models.list())
  app.post('/v1/responses', async (request, reply) => {
    await options.responses.handle(request, reply)
  })
  app.post('/v1/chat/completions', async (request, reply) => {
    await options.responses.handle(request, reply, 'chat-completions')
  })
}
