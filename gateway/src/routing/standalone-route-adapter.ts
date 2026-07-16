import { Readable, Writable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface SafeModel {
  readonly id: string
  readonly object: 'model'
  readonly owned_by: string
}

export interface SafeModelList {
  readonly object: 'list'
  readonly data: SafeModel[]
}

export interface ProviderRouteAdapter {
  listModels(): Promise<SafeModelList>
  forwardResponses(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<void>
  forwardChatCompletions?(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<void>
}

class SyntheticRequest extends Readable {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly socket = { remoteAddress: '127.0.0.1' }
  #payload: Buffer | null

  constructor(options: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: Record<string, unknown>
  }) {
    super()
    this.method = options.method
    this.url = options.url
    this.headers = {
      host: '127.0.0.1',
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
    this.#payload = options.body
      ? Buffer.from(JSON.stringify(options.body), 'utf8')
      : null
  }

  override _read(): void {
    if (this.#payload) {
      this.push(Buffer.from(this.#payload))
      this.#payload.fill(0)
      this.#payload = null
    }
    this.push(null)
  }
}

class ResponseBase extends Writable {
  statusCode = 200
  headersSent = false
  readonly headers = new Map<string, string | number | readonly string[]>()

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value)
    return this
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers.get(name.toLowerCase())
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase())
  }

  writeHead(
    statusCode: number,
    headers?: Record<string, string | number | readonly string[]>
  ): this {
    this.statusCode = statusCode
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    }
    this.headersSent = true
    return this
  }
}

class MemoryResponse extends ResponseBase {
  readonly chunks: Buffer[] = []

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
    callback()
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

class ForwardResponse extends ResponseBase {
  constructor(private readonly target: FastifyReply['raw']) {
    super()
  }

  override writeHead(
    statusCode: number,
    headers?: Record<string, string | number | readonly string[]>
  ): this {
    super.writeHead(statusCode, headers)
    if (!this.target.headersSent && !this.target.destroyed) {
      const outgoing: Record<string, string | number | string[]> = {}
      for (const [name, value] of this.headers) {
        outgoing[name] = Array.isArray(value) ? [...value] : value as string | number
      }
      this.target.writeHead(statusCode, outgoing)
    }
    return this
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (this.target.destroyed || this.target.writableEnded) {
      callback()
      return
    }
    this.target.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.target.destroyed && !this.target.writableEnded) this.target.end()
    callback()
  }
}

type StandaloneHandler = (request: SyntheticRequest, response: ResponseBase) => Promise<void>

export class StandaloneRouteAdapter implements ProviderRouteAdapter {
  #handler: StandaloneHandler | null = null

  constructor(private readonly options: { storageRoot: string }) {}

  async listModels(): Promise<SafeModelList> {
    const modelResponse = await this.requestMemory('GET', '/v1/models')
    const readinessResponse = await this.requestMemory('GET', '/ready')
    const modelBody = modelResponse.body()
    const readinessBody = readinessResponse.body()
    try {
      if (modelResponse.statusCode !== 200) {
        throw new Error(`Model catalog returned ${modelResponse.statusCode}`)
      }
      const value = JSON.parse(modelBody.toString('utf8')) as SafeModelList
      if (value.object !== 'list' || !Array.isArray(value.data)) {
        throw new Error('Model catalog response is invalid')
      }
      const readiness = JSON.parse(readinessBody.toString('utf8')) as {
        providers?: {
          deepseek?: boolean
          'openai-api'?: boolean
          'chatgpt-sub'?: boolean
          relays?: string[]
        }
      }
      const providers = readiness.providers || {}
      const relays = Array.isArray(providers.relays) ? providers.relays : []
      const anyProvider = Boolean(
        providers.deepseek ||
        providers['openai-api'] ||
        providers['chatgpt-sub'] ||
        relays.length
      )
      return {
        object: 'list',
        data: value.data.filter(model => {
          if (['auto', 'auto-fast', 'auto-cheap', 'auto-reliable'].includes(model.id)) {
            return anyProvider
          }
          if (model.id.startsWith('relay-')) {
            return relays.some(relayId => model.id.startsWith(`relay-${relayId}-`))
          }
          if (model.id.startsWith('openai-api-')) return providers['openai-api'] === true
          if (/^gpt-/i.test(model.id)) return providers['chatgpt-sub'] === true
          return providers.deepseek === true
        })
      }
    } finally {
      modelBody.fill(0)
      readinessBody.fill(0)
      for (const chunk of modelResponse.chunks) chunk.fill(0)
      for (const chunk of readinessResponse.chunks) chunk.fill(0)
    }
  }

  async forwardResponses(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<void> {
    await this.forward('/v1/responses', request, reply, body)
  }

  async forwardChatCompletions(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<void> {
    await this.forward('/v1/chat/completions', request, reply, body)
  }

  private async forward(
    url: string,
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>
  ): Promise<void> {
    reply.hijack()
    const response = new ForwardResponse(reply.raw)
    await this.handler()(new SyntheticRequest({
      method: 'POST',
      url,
      headers: {
        accept: String(request.headers.accept || 'text/event-stream')
      },
      body
    }), response)
  }

  private async requestMemory(method: string, url: string): Promise<MemoryResponse> {
    const response = new MemoryResponse()
    await this.handler()(new SyntheticRequest({ method, url }), response)
    if (!response.writableEnded) {
      await new Promise<void>((resolve, reject) => {
        response.once('finish', resolve)
        response.once('error', reject)
      })
    }
    return response
  }

  private handler(): StandaloneHandler {
    if (this.#handler) return this.#handler
    throw new Error('Standalone provider adapter is not initialized; call initialize()')
  }

  async initialize(): Promise<void> {
    if (this.#handler) return
    process.env['CODEX_PROXY_STORAGE_ROOT'] = path.resolve(this.options.storageRoot)
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..'
    )
    const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'src', 'server.js')).href
    const module = await import(moduleUrl) as {
      createServer(options?: { fetchImpl?: typeof fetch }): {
        listeners(name: string): unknown[]
        close(): void
      }
    }
    const server = module.createServer()
    const listener = server.listeners('request')[0]
    if (typeof listener !== 'function') throw new Error('Standalone request handler is unavailable')
    this.#handler = async (request, response) => {
      await (listener as (request: unknown, response: unknown) => Promise<void>)(request, response)
    }
  }
}
