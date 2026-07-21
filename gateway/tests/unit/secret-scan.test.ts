import { FixedClock } from '../../src/common/clock.js'
import { SafeLogger } from '../../src/common/logging.js'
import { redactValue } from '../../src/common/redaction.js'
import {
  assertSafeGatewayResponse,
  gatewayResponseSecretFindings
} from '../../src/security/response-secret-guard.js'

function jwtFixture(): string {
  return [
    `eyJ${'a'.repeat(16)}`,
    'b'.repeat(24),
    'c'.repeat(32)
  ].join('.')
}

describe('Gateway response, diagnostic and log secret guard', () => {
  it('blocks unknown API fields containing JWTs without echoing them', () => {
    const jwt = jwtFixture()
    const findings = gatewayResponseSecretFindings({
      diagnostic: { note: `unexpected Bearer ${jwt}` }
    })
    expect(findings.map(item => item.kind)).toEqual(
      expect.arrayContaining(['authorization', 'jwt'])
    )
    expect(JSON.stringify(findings)).not.toContain(jwt)
    expect(() => assertSafeGatewayResponse({
      diagnostic: `Bearer ${jwt}`
    })).toThrow(/响应包含不允许返回的敏感字段/)
  })

  it('allows masked summaries but blocks Provider payload fields', () => {
    expect(() => assertSafeGatewayResponse({
      credentials: [{
        maskedPreview: 'sk-...abcd',
        storageFormat: 'envelope-v1'
      }]
    })).not.toThrow()
    expect(() => assertSafeGatewayResponse({
      secret_payload: JSON.stringify({
        version: 1,
        algorithm: 'AES-256-GCM',
        key_id: 'key-test',
        nonce: 'bm9uY2Utbm9uY2U=',
        ciphertext: 'Y2lwaGVydGV4dA==',
        tag: 'dGFnLXRhZy10YWctdGFnLQ=='
      })
    })).toThrow(/响应包含不允许返回的敏感字段/)
    expect(() => assertSafeGatewayResponse({
      access_token: `dpapi-aesgcm:v1:${[
        Buffer.alloc(12, 4).toString('base64'),
        Buffer.alloc(16, 5).toString('base64'),
        Buffer.alloc(24, 6).toString('base64')
      ].join(':')}`
    })).toThrow(/响应包含不允许返回的敏感字段/)
  })

  it('redacts nested Error messages before structured logging', () => {
    const jwt = jwtFixture()
    const records: unknown[] = []
    const logger = new SafeLogger({
      clock: new FixedClock('2026-07-21T00:00:00.000Z'),
      sink: record => records.push(record)
    })
    logger.error('secret.fixture', {
      internalError: new Error(`upstream Authorization: Bearer ${jwt}`),
      redeemRequestId: `redeem_${'x'.repeat(24)}`
    })
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain(jwt)
    expect(serialized).not.toContain('redeem_')
    expect(serialized).toContain('[REDACTED]')
    expect(redactValue({ nonce: 'opaque-nonce' })).toEqual({
      nonce: '[REDACTED]'
    })
  })
})
