import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { AccountService } from '../auth/account-service.js'

function identity(request: FastifyRequest) {
  if (!request.accountIdentity) {
    throw new SafeError({
      code: 'login_required',
      message: 'AI Editor account login is required.',
      statusCode: 401
    })
  }
  return request.accountIdentity
}

function accountId(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>)['accountId']
  if (typeof value !== 'string' || !value) {
    throw new SafeError({
      code: 'invalid_request',
      message: 'Account identifier is required.',
      statusCode: 400
    })
  }
  return value
}

export function registerAccountSecurityRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  accounts: AccountService
}): void {
  app.post('/api/v1/admin/accounts/:accountId/temporary-password', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    const result = await options.accounts.issueTemporaryPassword(
      identity(request),
      accountId(request)
    )
    await reply.header('Cache-Control', 'no-store').send(result)
  })
}
