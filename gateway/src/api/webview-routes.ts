import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { WebviewSessionService } from '../auth/webview-session-service.js'

function ticketFromBody(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError({
      code: 'invalid_request',
      message: '管理页面会话请求无效。',
      statusCode: 400
    })
  }
  const ticket = (value as Record<string, unknown>)['ticket']
  if (typeof ticket !== 'string' || !ticket) {
    throw new SafeError({
      code: 'invalid_request',
      message: '管理页面会话缺少票据。',
      statusCode: 400
    })
  }
  return ticket
}

export function registerWebviewRoutes(
  app: FastifyInstance,
  service: WebviewSessionService
): void {
  app.post('/api/v1/webview/session', async (request, reply) => {
    if (request.headers.origin !== service.publicOrigin) {
      throw new SafeError({
        code: 'invalid_management_origin',
        message: '管理页面请求来源无效。',
        statusCode: 403
      })
    }
    const result = await service.exchange(ticketFromBody(request.body))
    await reply
      .header('Set-Cookie', result.cookie)
      .send({
        expiresIn: result.expiresIn,
        account: result.account,
        navigation: result.navigation
      })
  })

  app.delete('/api/v1/webview/session', async (request, reply) => {
    await service.revokeRequestSession(request)
    await reply
      .header('Set-Cookie', service.clearCookie())
      .status(204)
      .send()
  })
}

export function managementSessionAuthenticator(service: WebviewSessionService) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const identity = await service.authenticateRequest(request)
    request.accountRole = identity.role
    request.accountIdentity = identity
  }
}
