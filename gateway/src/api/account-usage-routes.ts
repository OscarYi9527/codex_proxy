import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type { WebviewSessionRepository } from '../db/repositories/webview-session-repository.js'

function addFixed6(left: string, right: string): string {
  const parse = (value: string) => {
    const match = /^(-?)(\d+)(?:\.(\d{0,6}))?$/.exec(value)
    if (!match) return 0n
    const units = BigInt(match[2] || '0') * 1_000_000n +
      BigInt((match[3] || '').padEnd(6, '0'))
    return match[1] === '-' ? -units : units
  }
  const total = parse(left) + parse(right)
  const sign = total < 0n ? '-' : ''
  const absolute = total < 0n ? -total : total
  return `${sign}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, '0')}`
}

export function registerAccountUsageRoutes(app: FastifyInstance, options: {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  repository: WebviewSessionRepository
}): void {
  app.get('/api/v1/admin/accounts/:accountId/usage', {
    preHandler: options.authenticate
  }, async request => {
    const accountId = (request.params as { accountId?: string }).accountId
    const identity = request.accountIdentity
    if (!identity || !accountId || accountId !== identity.accountId) {
      throw new SafeError({
        code: 'forbidden',
        message: '无权查看该账号的使用记录。',
        statusCode: 403
      })
    }
    const records = await options.repository.listAccountUsage(accountId)
    return {
      summary: records.reduce((summary, record) => ({
        requests: summary.requests + 1,
        inputTokens: summary.inputTokens + record.inputTokens,
        outputTokens: summary.outputTokens + record.outputTokens,
        settledCredits: addFixed6(summary.settledCredits, record.totalCredits)
      }), {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        settledCredits: '0.000000'
      }),
      records
    }
  })
}
