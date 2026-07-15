import { FixedClock } from '../../src/common/clock.js'
import { HmacSha256Digest } from '../../src/common/digests.js'
import { safeErrorBody, SafeError } from '../../src/common/errors.js'
import { SequenceIdSource } from '../../src/common/ids.js'
import { SafeLogger } from '../../src/common/logging.js'
import { redactValue } from '../../src/common/redaction.js'

describe('Gateway common deterministic and safe primitives', () => {
  it('provides deterministic clocks and IDs for contract tests', () => {
    const clock = new FixedClock('2026-07-16T00:00:00.000Z')
    const ids = new SequenceIdSource()
    expect(clock.now().toISOString()).toBe('2026-07-16T00:00:00.000Z')
    expect(ids.opaque('req')).toBe('req_test_0001')
    expect(ids.opaque('err')).toBe('err_test_0002')
  })

  it('uses keyed namespaced digests and constant-time matching', () => {
    const digests = new HmacSha256Digest('x'.repeat(32))
    const invitation = digests.digest('invitation', 'visible-secret')
    expect(invitation).not.toContain('visible-secret')
    expect(digests.matches('invitation', 'visible-secret', invitation)).toBe(true)
    expect(digests.matches('refresh-token', 'visible-secret', invitation)).toBe(false)
  })

  it('redacts nested secrets in structured logs', () => {
    const records: unknown[] = []
    const logger = new SafeLogger({
      clock: new FixedClock('2026-07-16T00:00:00.000Z'),
      sink: record => records.push(record)
    })
    logger.info('test', {
      authorization: 'Bearer secret',
      nested: { refreshToken: 'token', url: 'https://example.test?api_key=secret' }
    })
    expect(JSON.stringify(records)).not.toContain('Bearer secret')
    expect(JSON.stringify(records)).not.toContain('api_key=secret')
    expect(redactValue({ password: 'secret' })).toEqual({ password: '[REDACTED]' })
  })

  it('emits stable machine-readable safe errors', () => {
    const body = safeErrorBody(new SafeError({
      code: 'login_required',
      message: '需要登录。',
      statusCode: 401
    }), 'req_test')
    expect(body).toEqual({
      error: {
        code: 'login_required',
        message: '需要登录。',
        requestId: 'req_test',
        retryable: false
      }
    })
  })
})
