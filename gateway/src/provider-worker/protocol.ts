import crypto from 'node:crypto'

export const PROVIDER_WORKER_SIGNATURE_VERSION = 'aieditor-v1'
export const PROVIDER_USAGE_RECEIPT_VERSION = 'aieditor-usage-v1'

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

export interface ProviderUsageReceipt {
  readonly schemaVersion: 1
  readonly outboxId: string
  readonly executionId: string
  readonly turnId: string
  readonly workerId: string
  readonly region: string
  readonly providerId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly completedAt: string
  readonly signature: string
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

export function canonicalProviderUsageReceipt(
  input: Omit<ProviderUsageReceipt, 'schemaVersion' | 'signature'>
): string {
  return [
    PROVIDER_USAGE_RECEIPT_VERSION,
    input.outboxId,
    input.executionId,
    input.turnId,
    input.workerId,
    input.region,
    input.providerId,
    String(input.inputTokens),
    String(input.outputTokens),
    input.completedAt
  ].join('\n')
}

export function signProviderUsageReceipt(
  input: Omit<ProviderUsageReceipt, 'schemaVersion' | 'signature'>,
  signingSecret: string
): string {
  return `v1=${crypto
    .createHmac('sha256', signingSecret)
    .update(canonicalProviderUsageReceipt(input))
    .digest('hex')}`
}

export function verifyProviderUsageReceipt(
  value: unknown,
  options: {
    readonly signingSecret: string
    readonly workerId: string
    readonly region: string
  }
): ProviderUsageReceipt {
  const receipt = value as Partial<ProviderUsageReceipt> | null
  const opaqueId = /^[A-Za-z0-9._:-]{1,160}$/
  if (
    receipt?.schemaVersion !== 1 ||
    !opaqueId.test(String(receipt.outboxId || '')) ||
    !opaqueId.test(String(receipt.executionId || '')) ||
    !opaqueId.test(String(receipt.turnId || '')) ||
    receipt.workerId !== options.workerId ||
    receipt.region !== options.region ||
    !opaqueId.test(String(receipt.providerId || '')) ||
    !Number.isSafeInteger(receipt.inputTokens) ||
    Number(receipt.inputTokens) < 0 ||
    !Number.isSafeInteger(receipt.outputTokens) ||
    Number(receipt.outputTokens) < 0 ||
    typeof receipt.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    typeof receipt.signature !== 'string' ||
    !/^v1=[a-f0-9]{64}$/.test(receipt.signature)
  ) {
    throw new Error('Provider Worker usage receipt is malformed')
  }
  const unsigned = {
    outboxId: receipt.outboxId!,
    executionId: receipt.executionId!,
    turnId: receipt.turnId!,
    workerId: receipt.workerId!,
    region: receipt.region!,
    providerId: receipt.providerId!,
    inputTokens: receipt.inputTokens!,
    outputTokens: receipt.outputTokens!,
    completedAt: receipt.completedAt!
  }
  const expected = Buffer.from(signProviderUsageReceipt(
    unsigned,
    options.signingSecret
  ))
  const candidate = Buffer.from(receipt.signature)
  try {
    if (
      candidate.length !== expected.length ||
      !crypto.timingSafeEqual(candidate, expected)
    ) {
      throw new Error('Provider Worker usage receipt signature is invalid')
    }
  } finally {
    expected.fill(0)
    candidate.fill(0)
  }
  return {
    schemaVersion: 1,
    ...unsigned,
    signature: receipt.signature
  }
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
