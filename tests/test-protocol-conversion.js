import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  chatCompletionToResponse,
  responsesToChatCompletions
} from '../src/convert/chat-completions.js'
import { SSEDecoder } from '../src/convert/sse.js'
import {
  streamAnthropicToResponses,
  streamChatCompletionToResponses
} from '../src/convert/stream.js'

class MockResponse extends EventEmitter {
  constructor({ blockOn } = {}) {
    super()
    this.blockOn = blockOn
    this.blockedOnce = false
    this.chunks = []
    this.headers = null
    this.statusCode = null
    this.writableEnded = false
    this.writableNeedDrain = false
    this.destroyed = false
    this.blocked = new Promise(resolve => { this.resolveBlocked = resolve })
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode
    this.headers = headers
  }

  write(chunk) {
    const text = String(chunk)
    this.chunks.push(text)
    if (!this.blockedOnce && this.blockOn?.(text)) {
      this.blockedOnce = true
      this.writableNeedDrain = true
      this.resolveBlocked()
      return false
    }
    return true
  }

  releaseDrain() {
    this.writableNeedDrain = false
    this.emit('drain')
  }

  closeConnection() {
    this.destroyed = true
    this.emit('close')
  }

  end(chunk = '') {
    if (chunk) this.chunks.push(String(chunk))
    this.writableEnded = true
  }

  get text() {
    return this.chunks.join('')
  }
}

function upstream(chunks) {
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      }
    }
  }
}

function dataFrame(value, newline = '\n') {
  const data = typeof value === 'string' ? value : JSON.stringify(value)
  return `data: ${data}${newline}${newline}`
}

function parsedResponseEvents(res) {
  const decoder = new SSEDecoder()
  const frames = [
    ...decoder.push(Buffer.from(res.text)),
    ...decoder.end()
  ]
  return frames
    .filter(frame => frame.data !== '[DONE]')
    .map(frame => JSON.parse(frame.data))
}

describe('Responses <-> Chat Completions request/response conversion', () => {
  it('preserves string arguments, serializes objects once, merges calls, and wraps custom input', () => {
    const request = responsesToChatCompletions({
      model: 'proxy-model',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: 'Keep tool output concise.'
        },
        {
          type: 'function_call',
          call_id: 'call_string',
          name: 'lookup',
          arguments: '{"city":"Paris"}'
        },
        {
          type: 'function_call',
          call_id: 'call_object',
          name: 'calculate',
          arguments: { x: 1 }
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: '*** Begin Patch\n'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: 'Done'
        }
      ],
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'custom', name: 'apply_patch' }
      ]
    }, 'upstream-model')

    assert.deepEqual(request.stream_options, { include_usage: true })
    assert.deepEqual(request.messages[0], {
      role: 'developer',
      content: 'Keep tool output concise.'
    })
    const assistant = request.messages[1]
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.tool_calls.length, 3)
    assert.equal(assistant.tool_calls[0].function.arguments, '{"city":"Paris"}')
    assert.deepEqual(JSON.parse(assistant.tool_calls[1].function.arguments), { x: 1 })
    assert.deepEqual(JSON.parse(assistant.tool_calls[2].function.arguments), {
      input: '*** Begin Patch\n'
    })
    assert.deepEqual(request.messages[2], {
      role: 'tool',
      tool_call_id: 'call_patch',
      content: 'Done'
    })
  })

  it('restores custom tool calls and incomplete status in non-streaming responses', () => {
    const response = chatCompletionToResponse({
      id: 'chatcmpl_1',
      created: 123,
      choices: [{
        finish_reason: 'length',
        message: {
          tool_calls: [
            {
              id: 'call_fn',
              type: 'function',
              function: { name: 'lookup', arguments: '{"city":"Paris"}' }
            },
            {
              id: 'call_custom',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{"input":"patch text"}' }
            }
          ]
        }
      }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
    }, {
      model: 'proxy-model',
      tools: [{ type: 'custom', name: 'apply_patch' }]
    })

    assert.equal(response.status, 'incomplete')
    assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' })
    assert.deepEqual(response.output[0], {
      id: 'call_fn',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_fn',
      name: 'lookup',
      arguments: '{"city":"Paris"}'
    })
    assert.deepEqual(response.output[1], {
      id: 'call_custom',
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call_custom',
      name: 'apply_patch',
      input: 'patch text'
    })
  })
})

describe('incremental SSE decoder', () => {
  for (const [name, newline] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r']
  ]) {
    it(`supports ${name}, every two-chunk split, comments, multiline data, and UTF-8`, () => {
      const source = [
        ': ignored',
        'event: custom',
        'id: event-7',
        'data: 你好',
        'data: world',
        '',
        ''
      ].join(newline)
      const bytes = Buffer.from(source)

      for (let split = 1; split < bytes.length; split++) {
        const decoder = new SSEDecoder()
        const events = [
          ...decoder.push(bytes.subarray(0, split)),
          ...decoder.push(bytes.subarray(split)),
          ...decoder.end()
        ]
        assert.deepEqual(events, [{
          event: 'custom',
          data: '你好\nworld',
          id: 'event-7'
        }], `split at byte ${split}`)
      }
    })
  }

  it('flushes a final UTF-8 event at EOF without a blank line', () => {
    const bytes = Buffer.from('data: 尾部')
    const split = bytes.length - 1
    const decoder = new SSEDecoder()
    assert.deepEqual([
      ...decoder.push(bytes.subarray(0, split)),
      ...decoder.end(bytes.subarray(split))
    ], [{ event: 'message', data: '尾部' }])
  })
})

describe('Chat Completions streaming conversion', () => {
  it('keeps interleaved tool indexes independent, avoids first-delta duplication, and includes usage-only chunks', async () => {
    const frames = [
      dataFrame({
        choices: [{ delta: { content: 'hi' }, finish_reason: null }]
      }, '\r\n'),
      dataFrame({
        choices: [{
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_a',
                type: 'function',
                function: { name: 'lookup', arguments: '{"x":' }
              },
              {
                index: 1,
                id: 'call_b',
                type: 'function',
                function: { name: 'apply_patch', arguments: '{"input":"hel' }
              }
            ]
          },
          finish_reason: null
        }]
      }, '\r\n'),
      dataFrame({
        choices: [{
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: 'lo"}' } },
              { index: 0, function: { arguments: '1}' } }
            ]
          },
          finish_reason: null
        }]
      }, '\r\n'),
      dataFrame({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }]
      }, '\r\n'),
      dataFrame({
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
      }, '\r\n'),
      dataFrame('[DONE]', '\r\n')
    ].join('')
    const firstBoundary = frames.indexOf('\r\n\r\n')
    const chunks = [
      Buffer.from(frames.slice(0, firstBoundary + 3)),
      Buffer.from(frames.slice(firstBoundary + 3))
    ]
    const res = new MockResponse()

    await streamChatCompletionToResponses(upstream(chunks), res, {
      model: 'proxy-model',
      tools: [{ type: 'custom', name: 'apply_patch' }]
    })

    const events = parsedResponseEvents(res)
    const completed = events.find(event => event.type === 'response.completed')
    assert.ok(completed)
    assert.deepEqual(completed.response.usage, {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16
    })

    const normal = completed.response.output.find(item => item.name === 'lookup')
    const custom = completed.response.output.find(item => item.name === 'apply_patch')
    assert.equal(normal.arguments, '{"x":1}')
    assert.equal(custom.type, 'custom_tool_call')
    assert.equal(custom.input, 'hello')

    const normalAdded = events.find(event =>
      event.type === 'response.output_item.added' && event.item.call_id === 'call_a')
    assert.equal(normalAdded.item.arguments, '')
    assert.deepEqual(events
      .filter(event => event.type === 'response.function_call_arguments.delta' && event.item_id === normal.id)
      .map(event => event.delta), ['{"x":', '1}'])
    assert.equal(events.some(event =>
      event.type === 'response.function_call_arguments.delta' && event.item_id === custom.id), false)
    assert.equal(events.find(event =>
      event.type === 'response.custom_tool_call_input.done' && event.item_id === custom.id).input, 'hello')

    const outputTextDone = events.findIndex(event => event.type === 'response.output_text.done')
    const contentPartDone = events.findIndex(event => event.type === 'response.content_part.done')
    const messageItemDone = events.findIndex(event =>
      event.type === 'response.output_item.done' && event.item.type === 'message')
    assert.ok(outputTextDone < contentPartDone)
    assert.ok(contentPartDone < messageItemDone)
  })

  for (const [finishReason, incompleteReason] of [
    ['length', 'max_output_tokens'],
    ['content_filter', 'content_filter']
  ]) {
    it(`maps ${finishReason} to response.incomplete`, async () => {
      const res = new MockResponse()
      await streamChatCompletionToResponses(upstream([
        dataFrame({
          choices: [{ delta: { content: 'partial' }, finish_reason: null }]
        }),
        dataFrame({
          choices: [{ delta: {}, finish_reason: finishReason }]
        }),
        dataFrame('[DONE]')
      ]), res, { model: 'proxy-model' })

      const events = parsedResponseEvents(res)
      const incomplete = events.find(event => event.type === 'response.incomplete')
      assert.ok(incomplete)
      assert.equal(incomplete.response.status, 'incomplete')
      assert.deepEqual(incomplete.response.incomplete_details, { reason: incompleteReason })
      assert.equal(events.some(event => event.type === 'response.completed'), false)
    })
  }

  it('maps EOF before any finish reason to response.failed', async () => {
    const res = new MockResponse()
    await streamChatCompletionToResponses(upstream([
      'data: {"choices":[{"delta":{"content":"unterminated"},"finish_reason":null}]}'
    ]), res, { model: 'proxy-model' })

    const events = parsedResponseEvents(res)
    const failed = events.find(event => event.type === 'response.failed')
    assert.ok(failed)
    assert.equal(failed.response.status, 'failed')
    assert.equal(failed.response.error.code, 'upstream_closed')
    assert.equal(events.some(event => event.type === 'response.completed'), false)
    assert.match(res.text, /data: \[DONE\]/)
  })

  it('fails the Responses stream when an upstream frame is invalid', async () => {
    const res = new MockResponse()
    await streamChatCompletionToResponses(upstream([
      'data: {not-json}\n\n',
      dataFrame({
        choices: [{ delta: {}, finish_reason: 'stop' }]
      }),
      dataFrame('[DONE]')
    ]), res, { model: 'proxy-model' })

    const events = parsedResponseEvents(res)
    assert.equal(events.find(event => event.type === 'response.failed').response.error.code, 'invalid_upstream_event')
    assert.equal(events.some(event => event.type === 'response.completed'), false)
  })

  it('fails cleanly when the upstream body throws after headers', async () => {
    const res = new MockResponse()
    const source = {
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(dataFrame({
            choices: [{ delta: { content: 'partial' }, finish_reason: null }]
          }))
          throw new Error('truncated upstream stream')
        }
      }
    }

    await streamChatCompletionToResponses(source, res, { model: 'proxy-model' })

    const events = parsedResponseEvents(res)
    assert.equal(events.find(event => event.type === 'response.failed').response.error.code, 'upstream_stream_error')
    assert.match(res.text, /data: \[DONE\]/)
  })

  it('buffers arguments until a split custom-tool name is known', async () => {
    const res = new MockResponse()
    await streamChatCompletionToResponses(upstream([
      dataFrame({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_delayed',
              function: { arguments: '{"input":"hel' }
            }]
          },
          finish_reason: null
        }]
      }),
      dataFrame({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'apply_' }
            }]
          },
          finish_reason: null
        }]
      }),
      dataFrame({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'patch', arguments: 'lo"}' }
            }]
          },
          finish_reason: null
        }]
      }),
      dataFrame({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }]
      }),
      dataFrame({
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3 }
      }),
      dataFrame('[DONE]')
    ]), res, {
      model: 'proxy-model',
      tools: [{ type: 'custom', name: 'apply_patch' }]
    })

    const events = parsedResponseEvents(res)
    const added = events.find(event =>
      event.type === 'response.output_item.added' &&
      event.item.call_id === 'call_delayed'
    )
    assert.equal(added.item.type, 'custom_tool_call')
    assert.equal(added.item.name, 'apply_patch')
    assert.equal(events.some(event =>
      event.type === 'response.function_call_arguments.delta' &&
      event.item_id === added.item.id
    ), false)
    const completed = events.find(event => event.type === 'response.completed')
    assert.equal(completed.response.output[0].input, 'hello')
    assert.deepEqual(completed.response.usage, {
      input_tokens: 4,
      output_tokens: 3,
      total_tokens: 7
    })
  })

  it('waits for drain before pulling the next upstream frame', async () => {
    const first = dataFrame({
      choices: [{ delta: { content: 'first' }, finish_reason: null }]
    })
    const second = dataFrame({
      choices: [{ delta: {}, finish_reason: 'stop' }]
    }) + dataFrame('[DONE]')
    let secondRequested = false
    const source = {
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(first)
          secondRequested = true
          yield Buffer.from(second)
        }
      }
    }
    const res = new MockResponse({
      blockOn: text => text.startsWith('event: response.output_text.delta')
    })

    const converting = streamChatCompletionToResponses(source, res, { model: 'proxy-model' })
    await res.blocked
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(secondRequested, false)
    res.releaseDrain()
    await converting
    assert.equal(secondRequested, true)
    assert.ok(parsedResponseEvents(res).some(event => event.type === 'response.completed'))
  })

  it('stops waiting and reading upstream when the downstream closes during backpressure', async () => {
    let secondRequested = false
    const source = {
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(dataFrame({
            choices: [{ delta: { content: 'first' }, finish_reason: null }]
          }))
          secondRequested = true
          yield Buffer.from(dataFrame({
            choices: [{ delta: {}, finish_reason: 'stop' }]
          }))
        }
      }
    }
    const res = new MockResponse({
      blockOn: text => text.startsWith('event: response.output_text.delta')
    })

    const converting = streamChatCompletionToResponses(source, res, { model: 'proxy-model' })
    await res.blocked
    res.closeConnection()
    await converting
    assert.equal(secondRequested, false)
    assert.equal(res.writableEnded, false)
  })
})

describe('Anthropic streaming conversion', () => {
  it('uses the incremental SSE decoder for multiline JSON, split UTF-8, and CR separators', async () => {
    const events = [
      ': comment\r' +
        'event: message\r' +
        'data: {"type":\r' +
        'data: "message_start","message":{"id":"msg_upstream","usage":{"input_tokens":2}}}\r\r',
      dataFrame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      }, '\r'),
      dataFrame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你好' }
      }, '\r'),
      dataFrame({ type: 'content_block_stop', index: 0 }, '\r'),
      dataFrame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 }
      }, '\r'),
      dataFrame({ type: 'message_stop' }, '\r')
    ].join('')
    const bytes = Buffer.from(events)
    const chunks = []
    for (let index = 0; index < bytes.length; index++) {
      chunks.push(bytes.subarray(index, index + 1))
    }
    const res = new MockResponse()

    await streamAnthropicToResponses(upstream(chunks), res, { model: 'deepseek-model' })

    const output = parsedResponseEvents(res)
    const completed = output.find(event => event.type === 'response.completed')
    assert.ok(completed)
    assert.equal(completed.response.output[0].content[0].text, '你好')
    assert.deepEqual(completed.response.usage, {
      input_tokens: 2,
      output_tokens: 2,
      total_tokens: 4
    })
    const contentDone = output.findIndex(event => event.type === 'response.content_part.done')
    const itemDone = output.findIndex(event =>
      event.type === 'response.output_item.done' && event.item.type === 'message')
    assert.ok(contentDone < itemDone)
  })

  it('emits response.failed when the Anthropic body throws', async () => {
    const source = {
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(dataFrame({
            type: 'message_start',
            message: { id: 'msg_partial', usage: { input_tokens: 1 } }
          }))
          throw new Error('anthropic stream reset')
        }
      }
    }
    const res = new MockResponse()

    await streamAnthropicToResponses(source, res, { model: 'deepseek-model' })

    const output = parsedResponseEvents(res)
    assert.equal(output.find(event => event.type === 'response.failed').response.error.code, 'upstream_stream_error')
    assert.match(res.text, /data: \[DONE\]/)
  })
})
