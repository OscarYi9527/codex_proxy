import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import { CreditService } from '../credits/credit-service.js'
import { RateService } from '../credits/rate-service.js'

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

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name]
  if (typeof value !== 'string' || !value) {
    throw new SafeError({
      code: 'invalid_request',
      message: '路径参数无效。',
      statusCode: 400
    })
  }
  return value
}

export function registerAdminCreditRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  credits: CreditService
  rates: RateService
}): void {
  app.get('/api/v1/admin/organizations/:organizationId/credit-periods/current', {
    preHandler: options.authenticate
  }, async request => {
    const actor = identity(request)
    const view = await options.credits.organizationView(
      actor,
      param(request, 'organizationId')
    )
    return actor.role === 'level1'
      ? { ...view, modelRates: await options.rates.visibleRates(actor) }
      : view
  })

  app.put('/api/v1/admin/organizations/:organizationId/monthly-credits', {
    preHandler: options.authenticate
  }, request => {
    const value = body(request)['allocatedCredits']
    return options.credits.setMonthlyCredits(
      identity(request),
      param(request, 'organizationId'),
      typeof value === 'number' || typeof value === 'string' ? value : ''
    )
  })

  app.put('/api/v1/admin/organizations/:organizationId/risk-policy', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    const input = body(request)
    await options.credits.setRiskPolicy(
      identity(request),
      param(request, 'organizationId'),
      {
        maxOverdraftPerTurn:
          typeof input['maxOverdraftPerTurn'] === 'number' ||
          typeof input['maxOverdraftPerTurn'] === 'string'
            ? input['maxOverdraftPerTurn']
            : '',
        maxCumulativeRisk:
          typeof input['maxCumulativeRisk'] === 'number' ||
          typeof input['maxCumulativeRisk'] === 'string'
            ? input['maxCumulativeRisk']
            : ''
      }
    )
    await reply.status(204).send()
  })

  app.put('/api/v1/admin/accounts/:accountId/credit-allocation', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    const value = body(request)['allocatedCredits']
    await options.credits.setUserAllocation(
      identity(request),
      param(request, 'accountId'),
      typeof value === 'number' || typeof value === 'string' ? value : ''
    )
    await reply.status(204).send()
  })

  app.get('/api/v1/admin/organizations/:organizationId/usage', {
    preHandler: options.authenticate
  }, request => options.credits.organizationUsage(
    identity(request),
    param(request, 'organizationId')
  ))

  app.get('/api/v1/admin/accounts/:accountId/usage', {
    preHandler: options.authenticate
  }, request => options.credits.accountUsage(
    identity(request),
    param(request, 'accountId')
  ))
}

