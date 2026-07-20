import { FixedClock, SystemClock } from '../../src/common/clock.js'
import { HmacSha256Digest } from '../../src/common/digests.js'
import { safeErrorBody, SafeError, toSafeError } from '../../src/common/errors.js'
import { CryptoIdSource, SequenceIdSource } from '../../src/common/ids.js'
import { SafeLogger } from '../../src/common/logging.js'
import { redactValue } from '../../src/common/redaction.js'

describe('Gateway common deterministic and safe primitives', () => {
  it('provides deterministic clocks and IDs for contract tests', () => {
    const clock = new FixedClock('2026-07-16T00:00:00.000Z')
    const ids = new SequenceIdSource()
    expect(clock.now().toISOString()).toBe('2026-07-16T00:00:00.000Z')
    expect(ids.opaque('req')).toBe('req_test_0001')
    expect(ids.opaque('err')).toBe('err_test_0002')
    expect(ids.secret()).toContain('test-secret-0003')
    expect(new SystemClock().nowMs()).toBeGreaterThan(0)
    expect(new SystemClock().now()).toBeInstanceOf(Date)
    expect(() => new FixedClock('not-a-date')).toThrow(/valid instant/)
  })

  it('creates bounded cryptographic IDs and rejects invalid entropy requests', () => {
    const ids = new CryptoIdSource()
    expect(ids.opaque('req')).toMatch(/^req_[a-f0-9]{32}$/)
    expect(ids.secret()).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(() => ids.secret(15)).toThrow(/between 16 and 128/)
    expect(() => ids.secret(129)).toThrow(/between 16 and 128/)
  })

  it('uses keyed namespaced digests and constant-time matching', () => {
    const digests = new HmacSha256Digest('x'.repeat(32))
    const invitation = digests.digest('invitation', 'visible-secret')
    expect(invitation).not.toContain('visible-secret')
    expect(digests.matches('invitation', 'visible-secret', invitation)).toBe(true)
    expect(digests.matches('refresh-token', 'visible-secret', invitation)).toBe(false)
    expect(digests.matches('invitation', 'visible-secret', 'short')).toBe(false)
    expect(() => new HmacSha256Digest('short')).toThrow(/at least 32 bytes/)
    expect(() => digests.digest('invalid namespace!', 'value')).toThrow(/namespace/)
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
    logger.warn('warning')
    logger.error('error')
    expect(records).toHaveLength(3)
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

  it('keeps retry timing on safe errors without changing the public body', () => {
    const error = new SafeError({
      code: 'upstream_recovering',
      message: 'retry later',
      statusCode: 503,
      retryable: true,
      retryAfterMs: 4_200
    })
    expect(error.retryAfterMs).toBe(4_200)
    expect(safeErrorBody(error, 'req_retry')).toEqual({
      error: {
        code: 'upstream_recovering',
        message: 'retry later',
        requestId: 'req_retry',
        retryable: true
      }
    })
  })

  it('maps Fastify body limit failures to a stable 413 error', () => {
    const error = toSafeError(Object.assign(
      new Error('body limit'),
      { code: 'FST_ERR_CTP_BODY_TOO_LARGE' }
    ))
    expect(error.code).toBe('request_too_large')
    expect(error.statusCode).toBe(413)
    expect(error.retryable).toBe(false)
  })
})
