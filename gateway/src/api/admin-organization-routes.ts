import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { OrganizationService } from '../organizations/organization-service.js'

function identity(request: FastifyRequest) {
  if (!request.accountIdentity) {
    throw new SafeError({ code: 'login_required', message: '需要登录 AI Editor 产品账号。', statusCode: 401 })
  }
  return request.accountIdentity
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new SafeError({ code: 'invalid_request', message: '请求正文无效。', statusCode: 400 })
  }
  return request.body as Record<string, unknown>
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name]
  if (typeof value !== 'string' || !value) {
    throw new SafeError({ code: 'invalid_request', message: '路径参数无效。', statusCode: 400 })
  }
  return value
}

export function registerAdminOrganizationRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  service: OrganizationService
}): void {
  app.get('/api/v1/admin/organizations', { preHandler: options.authenticate }, request =>
    options.service.organizations(identity(request)))
  app.post('/api/v1/admin/organizations', { preHandler: options.authenticate }, request =>
    options.service.createOrganization(identity(request), body(request)))
  app.get('/api/v1/admin/accounts', { preHandler: options.authenticate }, request =>
    options.service.accounts(identity(request)))
  app.post('/api/v1/admin/accounts/:accountId/enable', { preHandler: options.authenticate }, async (request, reply) => {
    await options.service.setAccountStatus(identity(request), param(request, 'accountId'), 'active')
    await reply.status(204).send()
  })
  app.post('/api/v1/admin/accounts/:accountId/disable', { preHandler: options.authenticate }, async (request, reply) => {
    await options.service.setAccountStatus(identity(request), param(request, 'accountId'), 'disabled')
    await reply.status(204).send()
  })
  app.get('/api/v1/admin/invitations', { preHandler: options.authenticate }, request =>
    options.service.invitations(identity(request)))
  app.post('/api/v1/admin/invitations', { preHandler: options.authenticate }, request =>
    options.service.createInvitation(identity(request), body(request)))
  app.post('/api/v1/admin/invitations/:invitationId/revoke', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    await options.service.revokeInvitation(identity(request), param(request, 'invitationId'))
    await reply.status(204).send()
  })
}
