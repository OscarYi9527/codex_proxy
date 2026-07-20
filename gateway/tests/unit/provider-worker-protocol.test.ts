import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProviderWorkerSignedHeaders,
  providerWorkerBodySha256,
  signProviderUsageReceipt,
  verifyProviderUsageReceipt
} from '../../src/provider-worker/protocol.js'

interface SigningFixture {
  readonly method: string
  readonly requestTarget: string
  readonly gatewayId: string
  readonly requestId: string
  readonly turnId: string
  readonly timestamp: number
  readonly nonce: string
  readonly body: string
  readonly signingSecret: string
  readonly bodySha256: string
  readonly signature: string
}

describe('Gateway Provider Worker signing protocol', () => {
  it('matches the language-neutral v1 signing fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'fixtures',
      'provider-worker-signing-v1.json'
    ), 'utf8')) as SigningFixture
    const body = Buffer.from(fixture.body, 'utf8')
    const headers = createProviderWorkerSignedHeaders({
      method: fixture.method,
      requestTarget: fixture.requestTarget,
      gatewayId: fixture.gatewayId,
      requestId: fixture.requestId,
      turnId: fixture.turnId,
      timestamp: fixture.timestamp,
      nonce: fixture.nonce,
      body,
      signingSecret: fixture.signingSecret
    })
    expect(providerWorkerBodySha256(body)).toBe(fixture.bodySha256)
    expect(headers['x-ai-editor-body-sha256']).toBe(fixture.bodySha256)
    expect(headers['x-ai-editor-signature']).toBe(fixture.signature)
    body.fill(0)
  })

  it('verifies signed usage receipts and rejects token tampering', () => {
    const unsigned = {
      outboxId: 'outbox_protocol_test',
      executionId: 'exec_protocol_test',
      turnId: 'turn_protocol_test',
      workerId: 'worker-local',
      region: 'local-development',
      providerId: 'provider-worker-mock',
      inputTokens: 11,
      outputTokens: 7,
      completedAt: '2026-07-20T00:00:00.000Z'
    }
    const receipt = {
      schemaVersion: 1 as const,
      ...unsigned,
      signature: signProviderUsageReceipt(unsigned, 'usage-receipt-test-secret-32bytes-minimum')
    }
    expect(verifyProviderUsageReceipt(receipt, {
      signingSecret: 'usage-receipt-test-secret-32bytes-minimum',
      workerId: 'worker-local',
      region: 'local-development'
    })).toEqual(receipt)
    expect(() => verifyProviderUsageReceipt({
      ...receipt,
      outputTokens: 8
    }, {
      signingSecret: 'usage-receipt-test-secret-32bytes-minimum',
      workerId: 'worker-local',
      region: 'local-development'
    })).toThrow(/signature/)
  })
})
