import fs from 'node:fs'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { type FastifyReply, type FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import type {
  GatewayProviderRuntimeConfiguration,
  ProviderForwardResult,
  ProviderRouteAdapter,
  SafeAccountPoolSnapshot,
  SafeModelList
} from '../routing/standalone-route-adapter.js'
import type { SettlementRecord } from '../credits/settlement-service.js'
import type { ProviderWorkerGatewayConfig } from '../config.js'
import {
  createProviderWorkerSignedHeaders,
  type ProviderUsageReceipt,
  verifyProviderUsageReceipt
} from './protocol.js'

const MAX_JSON_BYTES = 1024 * 1024
const MAX_AUDIT_CAPTURE_BYTES = 4 * 1024 * 1024

interface ProviderWorkerOutbox {
  readonly schemaVersion: 1
  readonly workerId: string
  readonly region: string
  readonly items: readonly unknown[]
}

interface ProviderWorkerTurnStatus {
  readonly turnId?: unknown
  readonly state?: unknown
  readonly usageReceipt?: unknown
}

function safeHeader(
  headers: IncomingMessage['headers'],
  name: string
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function workerError(
  code: string,
  statusCode: number,
  retryable = statusCode >= 500,
  cause?: unknown,
  retryAfterMs?: number
): SafeError {
  const message = code === 'provider_relogin_required'
    ? 'ChatGPT 订阅账号登录已失效，请一级管理员在“订阅账号”中重新登录。'
    : (statusCode >= 500
        ? '境外模型通道暂时不可用，请稍后重试。'
        : '境外模型通道拒绝了本次请求。')
  return new SafeError({
    code,
    message,
    statusCode,
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(cause !== undefined ? { cause } : {})
  })
}

async function readLimited(response: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunkValue of response) {
    const chunk = Buffer.from(chunkValue)
    size += chunk.length
    if (size > limit) {
      chunk.fill(0)
      for (const item of chunks) item.fill(0)
      throw workerError('provider_worker_response_too_large', 502, true)
    }
    chunks.push(chunk)
  }
  const value = Buffer.concat(chunks)
  for (const chunk of chunks) chunk.fill(0)
  return value
}

function parseSafeWorkerError(
  statusCode: number,
  body: Buffer,
  headers?: IncomingMessage['headers']
): SafeError {
  try {
    const value = JSON.parse(body.toString('utf8')) as {
      error?: {
        code?: unknown
        retryable?: unknown
        retryAfterMs?: unknown
      }
    }
    const code = typeof value.error?.code === 'string'
      ? value.error.code
      : 'provider_worker_rejected'
    const gatewayCode = code === 'worker_provider_relogin_required'
      ? 'provider_relogin_required'
      : code
    const bodyRetryAfterMs = Number(value.error?.retryAfterMs)
    const headerRetryAfterMs = Number(safeHeader(headers || {}, 'retry-after')) * 1000
    const retryAfterMs = Number.isFinite(bodyRetryAfterMs) && bodyRetryAfterMs > 0
      ? bodyRetryAfterMs
      : (Number.isFinite(headerRetryAfterMs) && headerRetryAfterMs > 0
          ? headerRetryAfterMs
          : undefined)
    return workerError(
      gatewayCode,
      statusCode,
      value.error?.retryable === true,
      undefined,
      retryAfterMs
    )
  } catch (error) {
    return workerError('provider_worker_invalid_error', 502, true, error)
  }
}

function responseResult(payload: Buffer, providerId?: string): ProviderForwardResult {
  let completed: Record<string, unknown> | null = null
  for (const line of payload.toString('utf8').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const value = line.slice('data:'.length).trim()
    if (!value || value === '[DONE]') continue
    try {
      const event = JSON.parse(value) as Record<string, unknown>
      if (event['type'] === 'response.completed') completed = event
    } catch {
      // Ignore unrelated or partial SSE data; the stream was already relayed.
    }
  }
  const response = completed?.['response'] as Record<string, unknown> | undefined
  const usageValue = response?.['usage'] as Record<string, unknown> | undefined
  const inputTokens = Number(usageValue?.['input_tokens'])
  const outputTokens = Number(usageValue?.['output_tokens'])
  const output = Array.isArray(response?.['output'])
    ? response['output'] as Array<Record<string, unknown>>
    : []
  const assistantText = output
    .flatMap(item => Array.isArray(item['content'])
      ? item['content'] as Array<Record<string, unknown>>
      : [])
    .filter(item => item['type'] === 'output_text' && typeof item['text'] === 'string')
    .map(item => String(item['text']))
    .join('')
  return {
    ...(providerId ? { providerId } : {}),
    ...(assistantText ? { assistantText } : {}),
    ...(Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
      ? { usage: { inputTokens, outputTokens } }
      : {})
  }
}

export class ProviderWorkerClient implements ProviderRouteAdapter {
  readonly #origin: URL
  readonly #tls: {
    readonly key: Buffer
    readonly cert: Buffer
    readonly ca: Buffer
  } | null

  constructor(
    private readonly config: ProviderWorkerGatewayConfig,
    private readonly now: () => number = () => Date.now()
  ) {
    this.#origin = new URL(config.origin)
    this.#tls = config.tls
      ? {
          key: fs.readFileSync(config.tls.keyFile),
          cert: fs.readFileSync(config.tls.certFile),
          ca: fs.readFileSync(config.tls.caFile)
        }
      : null
  }

  async listModels(): Promise<SafeModelList> {
    const value = await this.requestJson<SafeModelList>(
      'GET',
      '/internal/v1/models',
      undefined,
      'models'
    )
    if (
      value.object !== 'list' ||
      !Array.isArray(value.data) ||
      value.data.some(model =>
        typeof model?.id !== 'string' ||
        model.object !== 'model' ||
        typeof model.owned_by !== 'string'
      )
    ) {
      throw workerError('provider_worker_model_catalog_invalid', 502, true)
    }
    return value
  }

  async configureProviders(
    configuration: GatewayProviderRuntimeConfiguration
  ): Promise<void> {
    const routedModels = configuration.fallbackChain
      .filter(route => route.provider === 'chatgpt-sub')
      .map(route => route.model)
    const modelIds = [...new Set([
      ...routedModels,
      ...configuration.modelIds.filter(model => /^gpt-/i.test(model))
    ])]
    const accounts = configuration.chatgptAccounts.map(account => ({ ...account }))
    await this.requestJson(
      'PUT',
      '/internal/v1/runtime/chatgpt-sub',
      {
        schemaVersion: 1,
        provider: 'chatgpt-sub',
        enabled: accounts.some(account =>
          account['routing_enabled'] !== false &&
          Boolean(account['access_token'] || account['refresh_token'])
        ),
        experimental: true,
        responsesUrl: configuration.chatgptResponsesUrl,
        accountStrategy: configuration.chatgptAccountStrategy,
        accounts,
        modelIds
      },
      'configure_chatgpt'
    )
  }

  async safeAccountPool(): Promise<SafeAccountPoolSnapshot> {
    return this.requestJson<SafeAccountPoolSnapshot>(
      'GET',
      '/internal/v1/runtime/chatgpt-sub/accounts',
      undefined,
      'account_pool'
    )
  }

  async safeDiagnostics(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      'GET',
      '/internal/v1/diagnostics',
      undefined,
      'diagnostics'
    )
  }

  async refreshChatgptAccountUsage(accountId: string): Promise<void> {
    await this.requestJson(
      'POST',
      `/internal/v1/runtime/chatgpt-sub/accounts/${
        encodeURIComponent(accountId)
      }/refresh-usage`,
      {},
      'refresh_usage'
    )
  }

  async listPendingUsage(limit = 100): Promise<ProviderUsageReceipt[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100)
    const value = await this.requestJson<ProviderWorkerOutbox>(
      'GET',
      `/internal/v1/usage/outbox?limit=${bounded}`,
      undefined,
      'usage_outbox'
    )
    if (
      value.schemaVersion !== 1 ||
      value.workerId !== this.config.workerId ||
      value.region !== this.config.region ||
      !Array.isArray(value.items)
    ) {
      throw workerError('provider_worker_outbox_invalid', 502, true)
    }
    try {
      return value.items.map(item => verifyProviderUsageReceipt(item, {
        signingSecret: this.config.signingSecret,
        workerId: this.config.workerId,
        region: this.config.region
      }))
    } catch (error) {
      throw workerError('provider_worker_usage_receipt_invalid', 502, true, error)
    }
  }

  async acknowledgeUsage(
    acknowledgements: ReadonlyArray<{
      readonly outboxId: string
      readonly turnId: string
      readonly settlementId: string
      readonly settledAt: string
    }>
  ): Promise<void> {
    if (!acknowledgements.length) return
    await this.requestJson(
      'POST',
      '/internal/v1/usage/outbox/ack',
      {
        schemaVersion: 1,
        acknowledgements: acknowledgements.map(value => ({ ...value }))
      },
      'usage_ack'
    )
  }

  async acknowledgeSettlement(
    result: ProviderForwardResult,
    usage: SettlementRecord
  ): Promise<void> {
    if (!result.usageReceipt) return
    await this.acknowledgeUsage([{
      outboxId: result.usageReceipt.outboxId,
      turnId: result.usageReceipt.turnId,
      settlementId: usage.id,
      settledAt: usage.completedAt
    }])
  }

  async forwardResponses(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<ProviderForwardResult> {
    return this.forward('/internal/v1/responses', request, reply, body)
  }

  async forwardChatCompletions(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<ProviderForwardResult> {
    return this.forward('/internal/v1/chat/completions', request, reply, body)
  }

  private async forward(
    requestTarget: string,
    request: FastifyRequest,
    reply: FastifyReply,
    bodyValue: Record<string, unknown>
  ): Promise<ProviderForwardResult> {
    const body = Buffer.from(JSON.stringify(bodyValue), 'utf8')
    const turnId = String(request.headers['x-ai-editor-turn-id'] || '')
    const requestId = String(request.id)
    try {
      const response = await this.request(
        'POST',
        requestTarget,
        body,
        turnId,
        requestId
      )
      if (response.statusCode !== 200) {
        const payload = await readLimited(response, MAX_JSON_BYTES)
        try {
          throw parseSafeWorkerError(
            response.statusCode || 502,
            payload,
            response.headers
          )
        } finally {
          payload.fill(0)
        }
      }
      reply.hijack()
      const outgoingHeaders: Record<string, string> = {
        'content-type': safeHeader(response.headers, 'content-type') ||
          'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': safeHeader(response.headers, 'x-request-id') || requestId
      }
      const providerId = safeHeader(response.headers, 'x-ai-editor-provider-id')
      const outboxId = safeHeader(response.headers, 'x-ai-editor-outbox-id')
      if (providerId) outgoingHeaders['x-ai-editor-provider-id'] = providerId
      const replay = safeHeader(response.headers, 'x-ai-editor-idempotent-replay')
      if (replay) outgoingHeaders['x-ai-editor-idempotent-replay'] = replay
      reply.raw.writeHead(200, outgoingHeaders)

      let captureEnabled = true
      let capturedBytes = 0
      const captured: Buffer[] = []
      const abort = () => response.destroy()
      request.raw.once('aborted', abort)
      try {
        for await (const chunkValue of response) {
          const chunk = Buffer.from(chunkValue)
          if (captureEnabled) {
            capturedBytes += chunk.length
            if (capturedBytes <= MAX_AUDIT_CAPTURE_BYTES) {
              captured.push(Buffer.from(chunk))
            } else {
              captureEnabled = false
              for (const item of captured) item.fill(0)
              captured.length = 0
            }
          }
          await new Promise<void>((resolve, reject) => {
            reply.raw.write(chunk, error => error ? reject(error) : resolve())
          })
          chunk.fill(0)
        }
      } finally {
        request.raw.removeListener('aborted', abort)
      }
      reply.raw.end()
      const payload = captureEnabled ? Buffer.concat(captured) : Buffer.alloc(0)
      for (const item of captured) item.fill(0)
      try {
        const result = captureEnabled
          ? responseResult(payload, providerId)
          : (providerId ? { providerId } : {})
        if (!outboxId) return result
        try {
          const receipt = await this.turnUsageReceipt(turnId, outboxId)
          return {
            ...result,
            usage: {
              inputTokens: receipt.inputTokens,
              outputTokens: receipt.outputTokens
            },
            usageReceipt: receipt
          }
        } catch {
          return {
            ...(result.providerId ? { providerId: result.providerId } : {}),
            ...(result.assistantText ? { assistantText: result.assistantText } : {}),
            deferSettlement: true
          }
        }
      } finally {
        payload.fill(0)
      }
    } catch (error) {
      if (error instanceof SafeError) throw error
      throw workerError('provider_worker_unavailable', 503, true, error)
    } finally {
      body.fill(0)
    }
  }

  private request(
    method: string,
    requestTarget: string,
    body: Buffer,
    turnId: string,
    requestId: string
  ): Promise<IncomingMessage> {
    const url = new URL(requestTarget, this.#origin)
    const headers = createProviderWorkerSignedHeaders({
      method,
      requestTarget,
      gatewayId: this.config.gatewayId,
      requestId,
      ...(turnId ? { turnId } : {}),
      body,
      signingSecret: this.config.signingSecret,
      timestamp: this.now()
    })
    const transport = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      const outgoing = transport.request(url, {
        method,
        headers: {
          ...headers,
          accept: method === 'GET' ? 'application/json' : 'text/event-stream',
          ...(body.length ? {
            'content-type': 'application/json',
            'content-length': body.length
          } : {})
        },
        ...(this.#tls ? {
          key: this.#tls.key,
          cert: this.#tls.cert,
          ca: this.#tls.ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2'
        } : {})
      }, response => {
        outgoing.setTimeout(0)
        resolve(response)
      })
      outgoing.once('error', reject)
      outgoing.setTimeout(30_000, () => {
        outgoing.destroy(new Error('Provider Worker connection timed out'))
      })
      outgoing.end(body.length ? body : undefined)
    })
  }

  private async requestJson<T>(
    method: string,
    requestTarget: string,
    value: Record<string, unknown> | undefined,
    operation: string,
    turnId = ''
  ): Promise<T> {
    const body = value === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(value), 'utf8')
    try {
      const response = await this.request(
        method,
        requestTarget,
        body,
        turnId,
        `req_worker_${operation}_${this.now()}`
      )
      const payload = await readLimited(response, MAX_JSON_BYTES)
      try {
        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          throw parseSafeWorkerError(
            response.statusCode || 502,
            payload,
            response.headers
          )
        }
        return JSON.parse(payload.toString('utf8')) as T
      } catch (error) {
        if (error instanceof SafeError) throw error
        throw workerError('provider_worker_invalid_json', 502, true, error)
      } finally {
        payload.fill(0)
      }
    } catch (error) {
      if (error instanceof SafeError) throw error
      throw workerError('provider_worker_unavailable', 503, true, error)
    } finally {
      body.fill(0)
    }
  }

  private async turnUsageReceipt(
    turnId: string,
    expectedOutboxId: string
  ): Promise<ProviderUsageReceipt> {
    const status = await this.requestJson<ProviderWorkerTurnStatus>(
      'GET',
      `/internal/v1/turns/${encodeURIComponent(turnId)}`,
      undefined,
      'turn_status',
      turnId
    )
    if (
      status.turnId !== turnId ||
      status.state !== 'completed' ||
      !status.usageReceipt
    ) {
      throw workerError('provider_worker_usage_receipt_missing', 502, true)
    }
    let receipt: ProviderUsageReceipt
    try {
      receipt = verifyProviderUsageReceipt(status.usageReceipt, {
        signingSecret: this.config.signingSecret,
        workerId: this.config.workerId,
        region: this.config.region
      })
    } catch (error) {
      throw workerError('provider_worker_usage_receipt_invalid', 502, true, error)
    }
    if (receipt.turnId !== turnId || receipt.outboxId !== expectedOutboxId) {
      throw workerError('provider_worker_usage_receipt_mismatch', 502, true)
    }
    return receipt
  }
}
