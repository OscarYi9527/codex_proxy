import './helpers/test-storage-root.js'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  pipeResponsesUpstream,
  RESPONSE_USAGE_TAIL_BYTES
} from '../src/server-utils.js'
import { GatewayClient } from '../src/edge/gateway-client.js'
import {
  DeferredErrorResponse,
  DEFERRED_ERROR_BODY_LIMIT_BYTES
} from '../src/smart-routing.js'

class TestResponse extends EventEmitter {
  constructor({ collect = true } = {}) {
    super()
    this.collect = collect
    this.chunks = []
    this.bytesWritten = 0
    this.destroyed = false
    this.writableEnded = false
    this.headersSent = false
    this.endCalls = 0
  }

  writeHead(status, headers = {}) {
    assert.equal(this.destroyed, false, 'writeHead must not run after destroy')
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
    return this
  }

  write(chunk) {
    assert.equal(this.destroyed, false, 'write must not run after destroy')
    const buffer = Buffer.from(chunk)
    this.bytesWritten += buffer.length
    if (this.collect) this.chunks.push(buffer)
    return true
  }

  end(chunk) {
    if (chunk != null) this.write(chunk)
    this.endCalls++
    this.writableEnded = true
    this.emit('finish')
    return this
  }
}

function responseWithBody(body, headers = { 'content-type': 'text/event-stream' }) {
  return {
    status: 200,
    headers: new Headers(headers),
    body
  }
}

async function withTimeout(promise, timeoutMs = 1000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('streaming transport resource control', () => {
  it('pauses upstream reads while the downstream is backpressured', async () => {
    let secondPullStarted = false
    let signalFirstWrite
    const firstWrite = new Promise(resolve => { signalFirstWrite = resolve })
    const body = (async function * () {
      yield Buffer.from('first')
      secondPullStarted = true
      yield Buffer.from('second')
    })()
    const output = new TestResponse()
    let writeCalls = 0
    output.write = function (chunk) {
      TestResponse.prototype.write.call(this, chunk)
      writeCalls++
      if (writeCalls === 1) {
        signalFirstWrite()
        return false
      }
      return true
    }

    const forwarding = pipeResponsesUpstream(responseWithBody(body), output)
    await firstWrite
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(secondPullStarted, false)
    assert.equal(output.endCalls, 0)

    output.emit('drain')
    await forwarding
    assert.equal(secondPullStarted, true)
    assert.equal(Buffer.concat(output.chunks).toString('utf8'), 'firstsecond')
    assert.equal(output.endCalls, 1)
  })

  it('extracts trailing JSON and SSE usage after long bodies with a fixed-size tail', async () => {
    assert.equal(RESPONSE_USAGE_TAIL_BYTES, 64 * 1024)

    const sseOutput = new TestResponse({ collect: false })
    let sseUsage
    const sseBody = (async function * () {
      const padding = `data: ${JSON.stringify({ delta: 'x'.repeat(32 * 1024) })}\n\n`
      for (let index = 0; index < 256; index++) yield Buffer.from(padding)
      yield Buffer.from(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 17,
            completion_tokens: 23,
            completion_tokens_details: { accepted_prediction_tokens: 3 },
            note: 'quoted brace } remains part of the string'
          }
        })}\r\n\r\ndata: [DONE]\r\n\r\n`
      )
    })()
    await pipeResponsesUpstream(responseWithBody(sseBody), sseOutput, {
      onBody: usage => { sseUsage = usage }
    })
    assert.ok(sseOutput.bytesWritten > RESPONSE_USAGE_TAIL_BYTES * 100)
    assert.equal(sseUsage.prompt_tokens, 17)
    assert.equal(sseUsage.completion_tokens_details.accepted_prediction_tokens, 3)

    const jsonOutput = new TestResponse({ collect: false })
    let jsonUsage
    const json = Buffer.from(JSON.stringify({
      padding: 'y'.repeat(RESPONSE_USAGE_TAIL_BYTES * 2),
      response: {
        usage: {
          input_tokens: 31,
          output_tokens: 47,
          output_tokens_details: { reasoning_tokens: 11 }
        }
      }
    }))
    await pipeResponsesUpstream(
      responseWithBody((async function * () { yield json })(), {
        'content-type': 'application/json'
      }),
      jsonOutput,
      { onBody: usage => { jsonUsage = usage } }
    )
    assert.equal(jsonUsage.input_tokens, 31)
    assert.equal(jsonUsage.output_tokens_details.reasoning_tokens, 11)
  })

  it('drains the Gateway response and resolves after the Edge client closes', async () => {
    const snapshot = {
      bindingVersion: 1,
      accessToken: 'access-token',
      accessTokenExpiresAt: Date.now() + 60_000,
      deviceSessionId: 'device-session'
    }
    let pulledChunks = 0
    let bodyCompleted = false
    const gatewayBody = (async function * () {
      for (let index = 0; index < 8; index++) {
        pulledChunks++
        await new Promise(resolve => setImmediate(resolve))
        yield Buffer.from(`chunk-${index}`)
      }
      bodyCompleted = true
    })()
    const client = new GatewayClient({
      gatewayOrigin: 'http://gateway.test',
      bindingStore: {
        async initialize() {},
        snapshot() { return snapshot }
      },
      fetchImpl: async () => responseWithBody(gatewayBody)
    })
    const output = new TestResponse({ collect: false })
    let writeCalls = 0
    output.write = function (chunk) {
      TestResponse.prototype.write.call(this, chunk)
      writeCalls++
      if (writeCalls === 1) {
        queueMicrotask(() => {
          this.destroyed = true
          this.emit('close')
        })
        return false
      }
      return true
    }

    await withTimeout(client.forward(
      '/v1/responses',
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'x-ai-editor-turn-id': 'turn_stream_transport'
        }
      },
      output,
      { model: 'real-model', input: 'hello', stream: true }
    ))

    assert.equal(bodyCompleted, true)
    assert.equal(pulledChunks, 8)
    assert.equal(writeCalls, 1)
    assert.equal(output.endCalls, 0)
  })

  it('bounds background draining when a disconnected Gateway stream never ends', async () => {
    const snapshot = {
      bindingVersion: 1,
      accessToken: 'access-token',
      accessTokenExpiresAt: Date.now() + 60_000,
      deviceSessionId: 'device-session'
    }
    let capturedSignal
    const client = new GatewayClient({
      gatewayOrigin: 'http://gateway.test',
      disconnectedDrainTimeoutMs: 20,
      bindingStore: {
        async initialize() {},
        snapshot() { return snapshot }
      },
      fetchImpl: async (_url, options) => {
        capturedSignal = options.signal
        const body = (async function * () {
          yield Buffer.from('first')
          await new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true
            })
          })
        })()
        return responseWithBody(body)
      }
    })
    const output = new TestResponse({ collect: false })
    output.write = function (chunk) {
      TestResponse.prototype.write.call(this, chunk)
      queueMicrotask(() => {
        this.destroyed = true
        this.emit('close')
      })
      return false
    }

    await withTimeout(client.forward(
      '/v1/responses',
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'x-ai-editor-turn-id': 'turn_bounded_background_drain'
        }
      },
      output,
      { model: 'real-model', input: 'hello', stream: true }
    ))

    assert.equal(capturedSignal.aborted, true)
    assert.equal(output.endCalls, 0)
  })

  it('bounds and safely replays an oversized deferred fallback error body', () => {
    const output = new TestResponse()
    const deferred = new DeferredErrorResponse(output)
    const prefix = Buffer.from('{"error":{"type":"upstream_overloaded","message":"')
    const oversized = Buffer.concat([
      prefix,
      Buffer.alloc(DEFERRED_ERROR_BODY_LIMIT_BYTES * 4, 0x78),
      Buffer.from('"}}')
    ])
    deferred.writeHead(503, {
      'content-type': 'application/json',
      'content-length': String(oversized.length)
    })
    assert.throws(
      () => deferred.write(oversized),
      error => error.code === 'UPSTREAM_ERROR_BODY_TOO_LARGE'
    )
    deferred.end()

    assert.equal(deferred.bodyTruncated, true)
    assert.equal(deferred.bufferedBytes, DEFERRED_ERROR_BODY_LIMIT_BYTES)
    assert.equal(
      deferred.chunks.reduce((total, chunk) => total + chunk.length, 0),
      DEFERRED_ERROR_BODY_LIMIT_BYTES
    )
    assert.equal(deferred.errorType(), 'upstream_overloaded')

    deferred.replay()
    assert.equal(output.statusCode, 503)
    assert.match(output.headers['content-type'], /application\/json/)
    assert.ok(output.bytesWritten < DEFERRED_ERROR_BODY_LIMIT_BYTES)
    assert.equal(output.headers['content-length'], String(output.bytesWritten))
    const replayed = JSON.parse(Buffer.concat(output.chunks).toString('utf8'))
    assert.equal(replayed.error.type, 'upstream_overloaded')
    assert.match(replayed.error.message, /exceeded 65536 bytes/)
    assert.equal(output.endCalls, 1)
  })

  it('cancels an oversized upstream error stream and removes delegated listeners', async () => {
    const output = new TestResponse()
    const deferred = new DeferredErrorResponse(output)
    let cancelled = false
    const body = (async function * () {
      try {
        while (true) yield Buffer.alloc(4096, 0x78)
      } finally {
        cancelled = true
      }
    })()
    const upstream = {
      status: 503,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body
    }

    await assert.rejects(
      pipeResponsesUpstream(upstream, deferred),
      error => error.code === 'UPSTREAM_ERROR_BODY_TOO_LARGE'
    )

    assert.equal(cancelled, true)
    assert.equal(deferred.bufferedBytes, DEFERRED_ERROR_BODY_LIMIT_BYTES)
    for (const event of ['close', 'error', 'finish']) {
      assert.equal(output.listenerCount(event), 0)
    }
  })
})
