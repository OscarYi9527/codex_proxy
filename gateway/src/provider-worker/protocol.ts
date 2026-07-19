import crypto from 'node:crypto'

export const PROVIDER_WORKER_SIGNATURE_VERSION = 'aieditor-v1'

export const PROVIDER_WORKER_HEADERS = {
  gatewayId: 'x-ai-editor-gateway-id',
  requestId: 'x-ai-editor-request-id',
  turnId: 'x-ai-editor-turn-id',
  timestamp: 'x-ai-editor-timestamp',
  nonce: 'x-ai-editor-nonce',
  bodySha256: 'x-ai-editor-body-sha256',
  signature: 'x-ai-editor-signature'
} as const

export interface ProviderWorkerSignatureInput {
  readonly method: string
  readonly requestTarget: string
  readonly gatewayId: string
  readonly requestId: string
  readonly turnId?: string
  readonly timestamp: number
  readonly nonce: string
  readonly bodySha256: string
}

export function providerWorkerBodySha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function canonicalProviderWorkerRequest(
  input: ProviderWorkerSignatureInput
): string {
  return [
    PROVIDER_WORKER_SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.requestTarget,
    input.gatewayId,
    input.requestId,
    input.turnId || '',
    String(input.timestamp),
    input.nonce,
    input.bodySha256
  ].join('\n')
}

export function signProviderWorkerRequest(
  input: ProviderWorkerSignatureInput,
  signingSecret: string
): string {
  return `v1=${crypto
    .createHmac('sha256', signingSecret)
    .update(canonicalProviderWorkerRequest(input))
    .digest('hex')}`
}

export function createProviderWorkerSignedHeaders(options: {
  readonly method: string
  readonly requestTarget: string
  readonly gatewayId: string
  readonly requestId: string
  readonly turnId?: string
  readonly body: Buffer
  readonly signingSecret: string
  readonly timestamp?: number
  readonly nonce?: string
}): Record<string, string> {
  const timestamp = options.timestamp ?? Date.now()
  const nonce = options.nonce || crypto.randomBytes(24).toString('base64url')
  const input: ProviderWorkerSignatureInput = {
    method: options.method,
    requestTarget: options.requestTarget,
    gatewayId: options.gatewayId,
    requestId: options.requestId,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    timestamp,
    nonce,
    bodySha256: providerWorkerBodySha256(options.body)
  }
  return {
    [PROVIDER_WORKER_HEADERS.gatewayId]: input.gatewayId,
    [PROVIDER_WORKER_HEADERS.requestId]: input.requestId,
    [PROVIDER_WORKER_HEADERS.turnId]: input.turnId || '',
    [PROVIDER_WORKER_HEADERS.timestamp]: String(input.timestamp),
    [PROVIDER_WORKER_HEADERS.nonce]: input.nonce,
    [PROVIDER_WORKER_HEADERS.bodySha256]: input.bodySha256,
    [PROVIDER_WORKER_HEADERS.signature]: signProviderWorkerRequest(
      input,
      options.signingSecret
    )
  }
}
