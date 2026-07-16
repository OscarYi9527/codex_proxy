import type { FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../../common/errors.js'
import type { AccessIdentity } from '../../auth/types.js'

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessIdentity | null>
}

export class FixedMockAccessTokenVerifier implements AccessTokenVerifier {
  async verify(token: string): Promise<AccessIdentity | null> {
    const shared = {
      accountId: 'acct_mock',
      deviceSessionId: 'ds_mock',
      organizationId: 'org_mock',
      accountVersion: 1,
      passwordVersion: 1
    }
    if (token === 'mock-level1-token') return { ...shared, role: 'level1' }
    if (token === 'mock-level2-token') return { ...shared, role: 'level2' }
    if (token === 'mock-access-token') return { ...shared, role: 'user' }
    return null
  }
}

export function requireAccessToken(verifier: AccessTokenVerifier) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '')
    const identity = match?.[1] ? await verifier.verify(match[1]) : null
    if (!identity) {
      throw new SafeError({
        code: 'login_required',
        message: '需要登录 AI Editor 产品账号。',
        statusCode: 401
      })
    }
    request.accountRole = identity.role
    request.accountIdentity = identity
  }
}
