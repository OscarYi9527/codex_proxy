import crypto from 'node:crypto'

function abortError() {
  return Object.assign(new Error('Provider Worker Turn was cancelled'), {
    statusCode: 409,
    code: 'worker_turn_cancelled'
  })
}

function delay(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortError())
    }, { once: true })
  })
}

function sse(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
}

export class MockProviderExecutor {
  async execute(options) {
    const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`
    const text = typeof options.body.mockText === 'string'
      ? options.body.mockText.slice(0, 2_000)
      : 'PROVIDER_WORKER_MOCK_OK'
    const usage = {
      inputTokens: Math.max(1, Math.ceil(Buffer.byteLength(
        JSON.stringify(options.body),
        'utf8'
      ) / 4)),
      outputTokens: Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4))
    }
    const chunks = [
      Buffer.from(sse('response.created', {
        type: 'response.created',
        response: {
          id: responseId,
          status: 'in_progress',
          model: options.body.model
        }
      }), 'utf8'),
      Buffer.from(sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: text
      }), 'utf8'),
      Buffer.from(sse('response.completed', {
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          model: options.body.model,
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }]
          }],
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens
          }
        }
      }), 'utf8')
    ]
    const initialDelay = Number(options.body.mockDelayMs) || 1
    const chunkDelay = Number(options.body.mockChunkDelayMs) || 0
    return {
      providerId: 'provider-worker-mock',
      usage,
      async *stream() {
        await delay(initialDelay, options.signal)
        for (const chunk of chunks) {
          if (options.signal.aborted) throw abortError()
          yield Buffer.from(chunk)
          if (chunkDelay > 0) await delay(chunkDelay, options.signal)
        }
        for (const chunk of chunks) chunk.fill(0)
      }
    }
  }
}
