import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { ProviderService } from '../providers/provider-service.js'
import type { RateService } from '../credits/rate-service.js'

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
  if (typeof value !== 'string' || !value) {
    throw new SafeError({
      code: 'invalid_request',
      message: `缺少路径字段 ${name}。`,
      statusCode: 400
    })
  }
  return value
}

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

export function registerAdminProviderRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  service: ProviderService
  rates: RateService
}): void {
  app.get('/api/v1/admin/providers', {
    preHandler: options.authenticate
  }, request => options.service.list(identity(request)))

  app.post('/api/v1/admin/providers', {
    preHandler: options.authenticate
  }, request => options.service.create(identity(request), asRecord(request.body)))

  app.get('/api/v1/admin/providers/:providerId', {
    preHandler: options.authenticate
  }, request => options.service.provider(identity(request), param(request, 'providerId')))

  app.patch('/api/v1/admin/providers/:providerId', {
    preHandler: options.authenticate
  }, request => options.service.update(
    identity(request),
    param(request, 'providerId'),
    asRecord(request.body)
  ))

  app.delete('/api/v1/admin/providers/:providerId', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    await options.service.remove(identity(request), param(request, 'providerId'))
    await reply.status(204).send()
  })

  app.post('/api/v1/admin/providers/:providerId/credentials', {
    preHandler: options.authenticate
  }, request => options.service.addCredential(
    identity(request),
    param(request, 'providerId'),
    asRecord(request.body)
  ))

  app.delete('/api/v1/admin/providers/:providerId/credentials/:credentialId', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    await options.service.removeCredential(
      identity(request),
      param(request, 'providerId'),
      param(request, 'credentialId')
    )
    await reply.status(204).send()
  })

  app.post('/api/v1/admin/providers/:providerId/chatgpt-login/start', {
    preHandler: options.authenticate
  }, async (request, reply) => {
    const result = await options.service.startChatgptLogin(
      identity(request),
      param(request, 'providerId')
    )
    await reply.status(202).send(result)
  })

  app.get('/api/v1/admin/providers/:providerId/chatgpt-login/status', {
    preHandler: options.authenticate
  }, request => options.service.chatgptLoginStatus(
    identity(request),
    param(request, 'providerId')
  ))

  app.get('/api/v1/admin/models', {
    preHandler: options.authenticate
  }, async request => {
    const actor = identity(request)
    return {
      ...await options.service.models(actor),
      rates: await options.rates.visibleRates(actor)
    }
  })

  app.put('/api/v1/admin/models/:modelId', {
    preHandler: options.authenticate
  }, async request => {
    const actor = identity(request)
    const modelId = param(request, 'modelId')
    const input = asRecord(request.body)
    const route = await options.service.putModel(actor, modelId, input)
    const hasRate = [
      'inputCreditPerToken',
      'outputCreditPerToken',
      'multiplier'
    ].some(key => input[key] !== undefined)
    const rate = hasRate
      ? await options.rates.setModelRate(actor, {
          modelId,
          inputCreditPerToken:
            typeof input['inputCreditPerToken'] === 'number' ||
            typeof input['inputCreditPerToken'] === 'string'
              ? input['inputCreditPerToken']
              : '',
          outputCreditPerToken:
            typeof input['outputCreditPerToken'] === 'number' ||
            typeof input['outputCreditPerToken'] === 'string'
              ? input['outputCreditPerToken']
              : '',
          multiplier:
            typeof input['multiplier'] === 'number' ||
            typeof input['multiplier'] === 'string'
              ? input['multiplier']
              : ''
        })
      : undefined
    return { ...route, ...(rate ? { rate } : {}) }
  })

  app.get('/api/v1/admin/diagnostics', {
    preHandler: options.authenticate
  }, request => options.service.diagnostics(identity(request)))

  app.get('/api/v1/admin/diagnostics/providers', {
    preHandler: options.authenticate
  }, request => options.service.diagnostics(identity(request), 'providers'))

  app.get('/api/v1/admin/diagnostics/circuits', {
    preHandler: options.authenticate
  }, request => options.service.diagnostics(identity(request), 'circuits'))

  app.get('/api/v1/admin/diagnostics/recent-route-errors', {
    preHandler: options.authenticate
  }, request => options.service.diagnostics(identity(request), 'recent-route-errors'))
}
