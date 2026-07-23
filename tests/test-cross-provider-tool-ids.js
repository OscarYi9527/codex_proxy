import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicToResponse, responsesToAnthropic } from '../src/convert/anthropic.js'
import { chatCompletionToResponse } from '../src/convert/chat-completions.js'
import {
  createChatStreamState,
  createStreamState,
  onAnthropicEvent,
  onChatCompletionChunk
} from '../src/convert/stream.js'
import {
  normalizeResponsesFunctionCallIds,
  responsesFunctionCallItemId
} from '../src/convert/tool-ids.js'
import { summarizeUpstreamErrorBody } from '../src/logger.js'
import { buildChatGptResponsesBody } from '../src/routes/chatgpt-sub.js'
import { summarizeDeepSeekRequestShape } from '../src/routes/deepseek.js'

describe('cross-provider tool call IDs', () => {
  it('creates stable, bounded Responses function_call IDs', () => {
    assert.equal(
      responsesFunctionCallItemId('tool_mrrmem914mxsqfk7'),
      'fc_tool_mrrmem914mxsqfk7'
    )
    assert.equal(responsesFunctionCallItemId('fc_existing'), 'fc_existing')

    const longId = `tool_${'x'.repeat(200)}`
    assert.equal(responsesFunctionCallItemId(longId), responsesFunctionCallItemId(longId))
    assert.ok(responsesFunctionCallItemId(longId).startsWith('fc_'))
    assert.ok(responsesFunctionCallItemId(longId).length <= 64)
  })

  it('repairs legacy GPT history while preserving call_id linkage', () => {
    const original = {
      input: [
        {
          type: 'function_call',
          id: 'tool_mrrmem914mxsqfk7',
          call_id: 'tool_mrrmem914mxsqfk7',
          name: 'read_file',
          arguments: '{}'
        },
        {
          type: 'function_call_output',
          call_id: 'tool_mrrmem914mxsqfk7',
          output: 'ok'
        }
      ]
    }

    const normalized = normalizeResponsesFunctionCallIds(original)
    assert.equal(normalized.input[0].id, 'fc_tool_mrrmem914mxsqfk7')
    assert.equal(normalized.input[0].call_id, 'tool_mrrmem914mxsqfk7')
    assert.equal(normalized.input[1].call_id, 'tool_mrrmem914mxsqfk7')
    assert.equal(original.input[0].id, 'tool_mrrmem914mxsqfk7')

    const upstream = buildChatGptResponsesBody(original, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    })
    assert.equal(upstream.input[0].id, 'fc_tool_mrrmem914mxsqfk7')
    assert.equal(upstream.input[0].call_id, 'tool_mrrmem914mxsqfk7')
    assert.equal(upstream.model, 'gpt-5.6-sol')
    assert.equal(upstream.store, false)
    assert.equal(upstream.reasoning.effort, 'high')
  })

  it('separates Responses id from call_id for non-streaming conversions', () => {
    const chatResponse = chatCompletionToResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'tool_chat_1',
            function: { name: 'read_file', arguments: '{"path":"a"}' }
          }]
        }
      }]
    }, { model: 'openai-api-gpt-5.6-sol' })
    assert.equal(chatResponse.output[0].id, 'fc_tool_chat_1')
    assert.equal(chatResponse.output[0].call_id, 'tool_chat_1')

    const anthropicResponse = anthropicToResponse({
      content: [{
        type: 'tool_use',
        id: 'toolu_deepseek_1',
        name: 'read_file',
        input: { path: 'a' }
      }]
    }, { model: 'deepseek-v4-pro' })
    assert.equal(anthropicResponse.output[0].id, 'fc_toolu_deepseek_1')
    assert.equal(anthropicResponse.output[0].call_id, 'toolu_deepseek_1')
  })

  it('preserves and pairs the original call_id in DeepSeek requests', () => {
    const { request } = responsesToAnthropic({
      input: [
        {
          type: 'function_call',
          id: 'fc_old_item',
          call_id: 'tool_original_1',
          name: 'read_file',
          arguments: '{"path":"a"}'
        },
        {
          type: 'function_call_output',
          call_id: 'tool_original_1',
          output: 'ok'
        }
      ]
    }, 'deepseek-v4-pro')

    const blocks = request.messages.flatMap(message => message.content)
    const toolUse = blocks.find(block => block.type === 'tool_use')
    const toolResult = blocks.find(block => block.type === 'tool_result')
    assert.equal(toolUse.id, 'tool_original_1')
    assert.equal(toolResult.tool_use_id, 'tool_original_1')
  })

  it('tracks interleaved streaming tool calls independently', () => {
    const writes = []
    const res = {
      write: value => writes.push(value),
      end: value => { if (value) writes.push(value) }
    }

    const anthropicState = createStreamState({ model: 'deepseek-v4-pro' }, new Set())
    onAnthropicEvent(res, anthropicState, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_stream_1', name: 'read_file' }
    })
    assert.equal(anthropicState.response.output[0].id, 'fc_toolu_stream_1')
    assert.equal(anthropicState.response.output[0].call_id, 'toolu_stream_1')

    const chatState = createChatStreamState({ model: 'openai-api-gpt-5.6-sol' })
    onChatCompletionChunk(res, chatState, {
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'tool_a', function: { name: 'first', arguments: '{"a":' } },
            { index: 1, id: 'tool_b', function: { name: 'second', arguments: '{"b":' } }
          ]
        }
      }]
    })
    onChatCompletionChunk(res, chatState, {
      choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }]
    })
    onChatCompletionChunk(res, chatState, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }]
    })

    assert.equal(chatState.response.output[0].id, 'fc_tool_a')
    assert.equal(chatState.response.output[0].call_id, 'tool_a')
    assert.equal(chatState.response.output[0].arguments, '{"a":1}')
    assert.equal(chatState.response.output[1].id, 'fc_tool_b')
    assert.equal(chatState.response.output[1].call_id, 'tool_b')
    assert.equal(chatState.response.output[1].arguments, '{"b":2}')
    assert.ok(writes.length > 0)
  })

  it('redacts DeepSeek diagnostics and only reports request shape', () => {
    const diagnostic = summarizeUpstreamErrorBody(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_tool_history',
        param: 'messages.3.content.0.tool_use_id',
        message: 'bad key sk-secret123456 password=hunter2'
      },
      request_body: 'must not be logged'
    }))
    assert.match(diagnostic, /type=invalid_request_error/)
    assert.match(diagnostic, /param=messages\.3/)
    assert.doesNotMatch(diagnostic, /sk-secret|hunter2|request_body/)

    const nonJson = summarizeUpstreamErrorBody('private user content')
    assert.match(nonJson, /^non_json_body bytes=/)
    assert.doesNotMatch(nonJson, /private user content/)

    assert.equal(
      summarizeDeepSeekRequestShape({
        messages: [
          { content: [{ type: 'tool_use' }] },
          { content: [{ type: 'tool_result' }] }
        ],
        tools: [{ name: 'read_file' }],
        stream: true
      }),
      'messages=2,tools=1,tool_uses=1,tool_results=1,stream=true'
    )
  })
})
