import type { FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../../common/errors.js'

export interface MockAccessTokenVerifier {
  verify(token: string): Promise<{ role: 'level1' | 'level2' | 'user' } | null>
}

export class FixedMockAccessTokenVerifier implements MockAccessTokenVerifier {
  async verify(token: string): Promise<{ role: 'level1' | 'level2' | 'user' } | null> {
    if (token === 'mock-level1-token') return { role: 'level1' }
    if (token === 'mock-level2-token') return { role: 'level2' }
    if (token === 'mock-access-token') return { role: 'user' }
    return null
  }
}

export function requireAccessToken(verifier: MockAccessTokenVerifier) {
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
  }
}
