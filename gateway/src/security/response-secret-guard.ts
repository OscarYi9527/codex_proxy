import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import {
  scanValueSecrets,
  type SecretFinding
} from '../../../src/secret-scan.js'

const INTENTIONAL_SECRET_ISSUANCE_ROUTES = new Set([
  '/api/v1/oauth/token',
  '/api/v1/account/password/change',
  '/api/v1/account/webview-ticket',
  '/api/v1/admin/providers/:providerId/chatgpt-login/start',
  '/api/v1/admin/providers/:providerId/chatgpt-login/status'
])

function guardedRoute(request: FastifyRequest): boolean {
  const route = request.routeOptions.url || ''
  return route.startsWith('/api/v1/') &&
    !INTENTIONAL_SECRET_ISSUANCE_ROUTES.has(route)
}

export function gatewayResponseSecretFindings(
  payload: unknown,
  source = 'gateway-api-response'
): readonly SecretFinding[] {
  return scanValueSecrets(payload, {
    source,
    maxFindings: 20
  })
}

export function assertSafeGatewayResponse(payload: unknown): void {
  const findings = gatewayResponseSecretFindings(payload)
  if (!findings.length) return
  throw new SafeError({
    code: 'response_secret_blocked',
    message: '响应包含不允许返回的敏感字段，已阻止发送。',
    statusCode: 500
  })
}

export function registerResponseSecretGuard(app: FastifyInstance): void {
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (guardedRoute(request)) assertSafeGatewayResponse(payload)
    return payload
  })
}
