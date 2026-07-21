import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AccessIdentity } from '../auth/types.js'
import { SafeError } from '../common/errors.js'
import type { InvitationService } from '../invitations/invitation-service.js'
import type { OrganizationService } from '../organizations/organization-service.js'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError({
      code: 'invalid_request',
      message: '请求正文无效。',
      statusCode: 400
    })
  }
  return value as Record<string, unknown>
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name]
  if (typeof value !== 'string' || !value || value.length > 160) {
    throw new SafeError({
      code: 'invalid_request',
      message: `路径字段 ${name} 无效。`,
      statusCode: 400
    })
  }
  return value
}

function identity(request: FastifyRequest): AccessIdentity {
  if (!request.accountIdentity) {
    throw new SafeError({
      code: 'login_required',
      message: '需要登录 AI Editor 产品账号。',
      statusCode: 401
    })
  }
  return request.accountIdentity
}

export function registerAdminOrganizationRoutes(
  app: FastifyInstance,
  options: {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    organizations: OrganizationService
    invitations: InvitationService
  }
): void {
  const authenticated = { preHandler: options.authenticate }

  app.get('/api/v1/admin/organizations', authenticated, request =>
    options.organizations.listOrganizations(identity(request))
  )

  app.post('/api/v1/admin/organizations', authenticated, async (request, reply) => {
    const result = await options.organizations.createOrganization(
      identity(request),
      asRecord(request.body)
    )
    await reply.status(201).send(result)
  })

  app.get(
    '/api/v1/admin/organizations/:organizationId',
    authenticated,
    request => options.organizations.getOrganization(
      identity(request),
      param(request, 'organizationId')
    )
  )

  app.patch(
    '/api/v1/admin/organizations/:organizationId',
    authenticated,
    request => options.organizations.updateOrganization(
      identity(request),
      param(request, 'organizationId'),
      asRecord(request.body)
    )
  )

  app.get('/api/v1/admin/accounts', authenticated, request =>
    options.organizations.listAccounts(identity(request))
  )

  app.get('/api/v1/admin/accounts/:accountId', authenticated, request =>
    options.organizations.getAccount(
      identity(request),
      param(request, 'accountId')
    )
  )

  app.patch('/api/v1/admin/accounts/:accountId', authenticated, request =>
    options.organizations.updateAccount(
      identity(request),
      param(request, 'accountId'),
      asRecord(request.body)
    )
  )

  app.post('/api/v1/admin/accounts/:accountId/enable', authenticated, request =>
    options.organizations.enableAccount(
      identity(request),
      param(request, 'accountId')
    )
  )

  app.post('/api/v1/admin/accounts/:accountId/disable', authenticated, request =>
    options.organizations.disableAccount(
      identity(request),
      param(request, 'accountId')
    )
  )

  app.put('/api/v1/admin/accounts/:accountId/role', authenticated, request =>
    options.organizations.updateRole(
      identity(request),
      param(request, 'accountId'),
      asRecord(request.body)
    )
  )

  app.post(
    '/api/v1/admin/accounts/:accountId/temporary-password',
    authenticated,
    request => options.organizations.issueTemporaryPassword(
      identity(request),
      param(request, 'accountId')
    )
  )

  app.delete(
    '/api/v1/admin/accounts/:accountId',
    authenticated,
    async (request, reply) => {
      await options.organizations.deleteAccount(
        identity(request),
        param(request, 'accountId')
      )
      await reply.status(204).send()
    }
  )

  app.get('/api/v1/admin/invitations', authenticated, request =>
    options.invitations.list(identity(request))
  )

  app.post('/api/v1/admin/invitations', authenticated, async (request, reply) => {
    const result = await options.invitations.create(
      identity(request),
      asRecord(request.body)
    )
    await reply.status(201).send(result)
  })

  app.post(
    '/api/v1/admin/invitations/:invitationId/revoke',
    authenticated,
    request => options.invitations.revoke(
      identity(request),
      param(request, 'invitationId')
    )
  )
}
