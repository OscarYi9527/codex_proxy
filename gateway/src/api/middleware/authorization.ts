import type { FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../../common/errors.js'

export function requireRole(...roles: ReadonlyArray<'level1' | 'level2' | 'user'>) {
  return async function authorize(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.accountRole || !roles.includes(request.accountRole)) {
      throw new SafeError({
        code: 'permission_denied',
        message: '当前账号无权执行此操作。',
        statusCode: 403
      })
    }
  }
}
