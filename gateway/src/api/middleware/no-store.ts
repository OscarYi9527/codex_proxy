import type { FastifyInstance } from 'fastify'

export function registerNoStore(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/')) {
      reply.header('Cache-Control', 'no-store')
      reply.header('Pragma', 'no-cache')
      reply.header('X-Content-Type-Options', 'nosniff')
    }
    return payload
  })
}
