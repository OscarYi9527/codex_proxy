import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProviderWorkerSignedHeaders,
  providerWorkerBodySha256
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
})
