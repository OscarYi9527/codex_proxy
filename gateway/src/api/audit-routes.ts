import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditService } from '../audit/audit-service.js'
import type { RetentionService } from '../audit/retention-service.js'
import { SafeError } from '../common/errors.js'

function identity(request: FastifyRequest) {
  if (!request.accountIdentity) {
    throw new SafeError({
      code: 'login_required',
      message: '需要登录 AI Editor 产品账号。',
      statusCode: 401
    })
  }
  return request.accountIdentity
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name]
  if (typeof value !== 'string' || !value || value.length > 240) {
    throw new SafeError({
      code: 'invalid_request',
      message: '审计路径参数无效。',
      statusCode: 400
    })
  }
  return value
}

function query(request: FastifyRequest): {
  organizationId?: string
  accountId?: string
  limit?: number
} {
  const value = request.query && typeof request.query === 'object'
    ? request.query as Record<string, unknown>
    : {}
  const result: {
    organizationId?: string
    accountId?: string
    limit?: number
  } = {}
  if (typeof value['organizationId'] === 'string' && value['organizationId']) {
    result.organizationId = value['organizationId'].slice(0, 240)
  }
  if (typeof value['accountId'] === 'string' && value['accountId']) {
    result.accountId = value['accountId'].slice(0, 240)
  }
  if (value['limit'] !== undefined) {
    const limit = Number(value['limit'])
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new SafeError({
        code: 'invalid_request',
        message: '审计查询数量无效。',
        statusCode: 400
      })
    }
    result.limit = limit
  }
  return result
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new SafeError({
      code: 'invalid_request',
      message: '请求正文无效。',
      statusCode: 400
    })
  }
  return request.body as Record<string, unknown>
}

export function registerAuditRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  audit: AuditService
  retention: RetentionService
}): void {
  app.get('/api/v1/admin/audit/conversations', {
    preHandler: options.authenticate
  }, async request => {
    await options.retention.cleanupExpiredBodies()
    return options.audit.conversations(identity(request), query(request))
  })

  app.get('/api/v1/admin/audit/conversations/:auditId', {
    preHandler: options.authenticate
  }, async request => {
    await options.retention.cleanupExpiredBodies()
    return options.audit.conversation(identity(request), param(request, 'auditId'))
  })

  app.get('/api/v1/admin/audit/admin-events', {
    preHandler: options.authenticate
  }, request => options.audit.adminEvents(identity(request), query(request)))

  app.put('/api/v1/admin/organizations/:organizationId/audit-retention', {
    preHandler: options.authenticate
  }, request => options.audit.setRetention(
    identity(request),
    param(request, 'organizationId'),
    body(request)['days']
  ))
}
