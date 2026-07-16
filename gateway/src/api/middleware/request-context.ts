import type { FastifyInstance } from 'fastify'
import type { IdSource } from '../../common/ids.js'
import type { AccessIdentity } from '../../auth/types.js'

declare module 'fastify' {
  interface FastifyRequest {
    safeRequestId: string
    accountRole?: 'level1' | 'level2' | 'user'
    accountIdentity?: AccessIdentity
  }
}

export function registerRequestContext(app: FastifyInstance, ids: IdSource): void {
  app.addHook('onRequest', async (request, reply) => {
    request.safeRequestId = request.id || ids.opaque('req')
    reply.header('X-Request-Id', request.safeRequestId)
  })
}
