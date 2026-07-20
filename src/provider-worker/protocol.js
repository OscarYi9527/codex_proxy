import crypto from 'node:crypto'

export const PROVIDER_WORKER_SIGNATURE_VERSION = 'aieditor-v1'
export const PROVIDER_USAGE_RECEIPT_VERSION = 'aieditor-usage-v1'

export const PROVIDER_WORKER_HEADERS = Object.freeze({
  gatewayId: 'x-ai-editor-gateway-id',
  requestId: 'x-ai-editor-request-id',
  turnId: 'x-ai-editor-turn-id',
  timestamp: 'x-ai-editor-timestamp',
  nonce: 'x-ai-editor-nonce',
  bodySha256: 'x-ai-editor-body-sha256',
  signature: 'x-ai-editor-signature'
})

function headerValue(headers, name) {
  const value = headers[name]
  return Array.isArray(value) ? value[0] || '' : String(value || '')
}

function isOpaqueId(value, allowEmpty = false) {
  if (allowEmpty && !value) return true
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function canonicalProviderWorkerRequest(input) {
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

export function signProviderWorkerRequest(input, signingSecret) {
  const canonical = canonicalProviderWorkerRequest(input)
  return `v1=${crypto
    .createHmac('sha256', signingSecret)
    .update(canonical)
    .digest('hex')}`
}

export function canonicalProviderUsageReceipt(input) {
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

export function signProviderUsageReceipt(input, signingSecret) {
  return `v1=${crypto
    .createHmac('sha256', signingSecret)
    .update(canonicalProviderUsageReceipt(input))
    .digest('hex')}`
}

export function createProviderUsageReceipt(input, signingSecret) {
  return {
    schemaVersion: 1,
    ...input,
    signature: signProviderUsageReceipt(input, signingSecret)
  }
}

export function createProviderWorkerSignedHeaders(options) {
  const bodySha256 = sha256Hex(options.body)
  const timestamp = options.timestamp ?? Date.now()
  const nonce = options.nonce || crypto.randomBytes(24).toString('base64url')
  const input = {
    method: options.method,
    requestTarget: options.requestTarget,
    gatewayId: options.gatewayId,
    requestId: options.requestId,
    turnId: options.turnId || '',
    timestamp,
    nonce,
    bodySha256
  }
  return {
    [PROVIDER_WORKER_HEADERS.gatewayId]: input.gatewayId,
    [PROVIDER_WORKER_HEADERS.requestId]: input.requestId,
    [PROVIDER_WORKER_HEADERS.turnId]: input.turnId,
    [PROVIDER_WORKER_HEADERS.timestamp]: String(input.timestamp),
    [PROVIDER_WORKER_HEADERS.nonce]: input.nonce,
    [PROVIDER_WORKER_HEADERS.bodySha256]: input.bodySha256,
    [PROVIDER_WORKER_HEADERS.signature]: signProviderWorkerRequest(
      input,
      options.signingSecret
    )
  }
}

export function verifyProviderWorkerRequest(options) {
  const gatewayId = headerValue(options.headers, PROVIDER_WORKER_HEADERS.gatewayId)
  const requestId = headerValue(options.headers, PROVIDER_WORKER_HEADERS.requestId)
  const turnId = headerValue(options.headers, PROVIDER_WORKER_HEADERS.turnId)
  const timestampValue = headerValue(options.headers, PROVIDER_WORKER_HEADERS.timestamp)
  const nonce = headerValue(options.headers, PROVIDER_WORKER_HEADERS.nonce)
  const bodySha256 = headerValue(options.headers, PROVIDER_WORKER_HEADERS.bodySha256)
  const signature = headerValue(options.headers, PROVIDER_WORKER_HEADERS.signature)
  const timestamp = Number(timestampValue)

  if (
    !isOpaqueId(gatewayId) ||
    !isOpaqueId(requestId) ||
    !isOpaqueId(turnId, options.allowEmptyTurnId === true) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(bodySha256) ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    !Number.isSafeInteger(timestamp)
  ) {
    throw Object.assign(new Error('Provider Worker request authentication is malformed'), {
      statusCode: 401,
      code: 'worker_authentication_invalid'
    })
  }
  if (!options.allowedGatewayIds.has(gatewayId)) {
    throw Object.assign(new Error('Gateway is not allowed to call this Provider Worker'), {
      statusCode: 403,
      code: 'worker_gateway_forbidden'
    })
  }
  if (Math.abs(options.now() - timestamp) > options.maxClockSkewMs) {
    throw Object.assign(new Error('Provider Worker request timestamp is outside the allowed window'), {
      statusCode: 401,
      code: 'worker_request_expired'
    })
  }
  const actualBodySha256 = sha256Hex(options.body)
  if (actualBodySha256 !== bodySha256) {
    throw Object.assign(new Error('Provider Worker request body digest does not match'), {
      statusCode: 401,
      code: 'worker_body_digest_invalid'
    })
  }
  const expected = Buffer.from(signProviderWorkerRequest({
    method: options.method,
    requestTarget: options.requestTarget,
    gatewayId,
    requestId,
    turnId,
    timestamp,
    nonce,
    bodySha256
  }, options.signingSecret))
  const candidate = Buffer.from(signature)
  try {
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      throw Object.assign(new Error('Provider Worker request signature is invalid'), {
        statusCode: 401,
        code: 'worker_signature_invalid'
      })
    }
  } finally {
    expected.fill(0)
    candidate.fill(0)
  }
  return {
    gatewayId,
    requestId,
    turnId,
    timestamp,
    nonce,
    bodySha256
  }
}
