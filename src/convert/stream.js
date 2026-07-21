// Streaming conversion helpers
// Anthropic SSE → Responses SSE and Chat Completions SSE → Responses SSE

import { id, asText, anthropicToResponse } from './anthropic.js'
import { recordUsage, saveStats } from '../stats.js'
import { proxyMetaHeaders } from '../server-utils.js'
import { safeErrorText } from '../logger.js'

export function writeEvent(res, state, type, payload = {}) {
  const event = { type, sequence_number: state.sequence++, ...payload }
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

// ── Anthropic SSE → Responses SSE ──────────────────────────────────

function responseShell(body, status = 'in_progress') {
  return {
    id: id('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: body.model || 'unknown',
    output: [],
    usage: null
  }
}

function anthropicUsage(usage = {}) {
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  return { input_tokens: input, output_tokens: output, total_tokens: input + output }
}

export function createStreamState(body, customTools) {
  return {
    sequence: 0,
    response: responseShell(body),
    customTools,
    blocks: new Map(),
    messageItem: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  }
}

function ensureMessage(res, state) {
  if (state.messageItem) return state.messageItem
  const item = { id: id('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }
  state.messageItem = item
  state.response.output.push(item)
  writeEvent(res, state, 'response.output_item.added', {
    output_index: state.response.output.length - 1,
    item: structuredClone(item)
  })
  return item
}

export function onAnthropicEvent(res, state, event) {
  const type = event.type
  if (type === 'message_start') {
    if (event.message?.id) state.response.id = event.message.id
    state.usage = anthropicUsage(event.message?.usage)
    writeEvent(res, state, 'response.created', { response: structuredClone(state.response) })
    writeEvent(res, state, 'response.in_progress', { response: structuredClone(state.response) })
    return
  }
  if (type === 'content_block_start') {
    const block = event.content_block || {}
    if (block.type === 'text') {
      const item = ensureMessage(res, state)
      const outputIndex = state.response.output.indexOf(item)
      const contentIndex = item.content.length
      const part = { type: 'output_text', text: '', annotations: [] }
      item.content.push(part)
      state.blocks.set(event.index, { kind: 'text', item, part, outputIndex, contentIndex })
      writeEvent(res, state, 'response.content_part.added', {
        item_id: item.id, output_index: outputIndex, content_index: contentIndex,
        part: structuredClone(part)
      })
      return
    }
    if (block.type === 'tool_use') {
      const isCustom = state.customTools.has(block.name)
      const item = {
        id: id('tool'),
        type: isCustom ? 'custom_tool_call' : 'function_call',
        status: 'in_progress',
        call_id: block.id,
        name: block.name,
        ...(isCustom ? { input: '' } : { arguments: '' })
      }
      state.response.output.push(item)
      const outputIndex = state.response.output.length - 1
      state.blocks.set(event.index, { kind: isCustom ? 'custom' : 'function', item, outputIndex, json: '' })
      writeEvent(res, state, 'response.output_item.added', {
        output_index: outputIndex, item: structuredClone(item)
      })
    }
    return
  }
  if (type === 'content_block_delta') {
    const current = state.blocks.get(event.index)
    if (!current) return
    if (event.delta?.type === 'text_delta' && current.kind === 'text') {
      const delta = event.delta.text || ''
      current.part.text += delta
      writeEvent(res, state, 'response.output_text.delta', {
        item_id: current.item.id, output_index: current.outputIndex,
        content_index: current.contentIndex, delta
      })
      return
    }
    if (event.delta?.type === 'input_json_delta') {
      const delta = event.delta.partial_json || ''
      current.json += delta
      if (current.kind !== 'custom') {
        current.item.arguments += delta
        writeEvent(res, state, 'response.function_call_arguments.delta', {
          item_id: current.item.id, output_index: current.outputIndex, delta
        })
      }
    }
    return
  }
  if (type === 'content_block_stop') {
    const current = state.blocks.get(event.index)
    if (!current) return
    if (current.kind === 'text') {
      writeEvent(res, state, 'response.output_text.done', {
        item_id: current.item.id, output_index: current.outputIndex,
        content_index: current.contentIndex, text: current.part.text
      })
      writeEvent(res, state, 'response.content_part.done', {
        item_id: current.item.id, output_index: current.outputIndex,
        content_index: current.contentIndex, part: structuredClone(current.part)
      })
    } else if (current.kind === 'custom') {
      try { current.item.input = JSON.parse(current.json).input || '' } catch { current.item.input = current.json }
      writeEvent(res, state, 'response.custom_tool_call_input.delta', {
        item_id: current.item.id, output_index: current.outputIndex, delta: current.item.input
      })
      writeEvent(res, state, 'response.custom_tool_call_input.done', {
        item_id: current.item.id, output_index: current.outputIndex, input: current.item.input
      })
      current.item.status = 'completed'
      writeEvent(res, state, 'response.output_item.done', {
        output_index: current.outputIndex, item: structuredClone(current.item)
      })
    } else {
      current.item.status = 'completed'
      writeEvent(res, state, 'response.function_call_arguments.done', {
        item_id: current.item.id, output_index: current.outputIndex, arguments: current.item.arguments
      })
      writeEvent(res, state, 'response.output_item.done', {
        output_index: current.outputIndex, item: structuredClone(current.item)
      })
    }
    state.blocks.delete(event.index)
    return
  }
  if (type === 'message_delta') {
    state.usage = anthropicUsage({
      input_tokens: state.usage.input_tokens,
      output_tokens: event.usage?.output_tokens || state.usage.output_tokens
    })
    return
  }
  if (type === 'message_stop') {
    if (state.messageItem) {
      state.messageItem.status = 'completed'
      writeEvent(res, state, 'response.output_item.done', {
        output_index: state.response.output.indexOf(state.messageItem),
        item: structuredClone(state.messageItem)
      })
    }
    state.response.status = 'completed'
    state.response.usage = state.usage
    recordUsage(state.response.model, 'deepseek', state.usage.input_tokens, state.usage.output_tokens)
    saveStats()
    writeEvent(res, state, 'response.completed', { response: structuredClone(state.response) })
    res.end('data: [DONE]\n\n')
  }
}

export async function streamAnthropicToResponses(upstream, res, body, customTools) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...proxyMetaHeaders(res)
  })
  const state = createStreamState(body, customTools)
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data || data === '[DONE]') continue
      try { onAnthropicEvent(res, state, JSON.parse(data)) } catch (error) {
        console.error('[codex-proxy] SSE conversion error:', safeErrorText(error))
      }
    }
  }
  if (!res.writableEnded) {
    state.response.status = 'failed'
    writeEvent(res, state, 'response.failed', {
      response: { ...state.response, error: { code: 'upstream_closed', message: 'Upstream stream ended unexpectedly' } }
    })
    res.end('data: [DONE]\n\n')
  }
}

// ── Chat Completions SSE → Responses SSE ───────────────────────────

export function createChatStreamState(body) {
  return {
    sequence: 0,
    response: responseShell(body),
    messageItem: null,
    contentPart: null,
    contentText: '',
    outputIndex: -1,
    contentIndex: -1
  }
}

function ensureChatMessage(res, state) {
  if (state.messageItem) return state.messageItem
  const item = { id: id('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }
  state.messageItem = item
  state.response.output.push(item)
  state.outputIndex = state.response.output.length - 1
  writeEvent(res, state, 'response.output_item.added', {
    output_index: state.outputIndex, item: structuredClone(item)
  })
  return item
}

function ensureChatContentPart(res, state) {
  const msg = ensureChatMessage(res, state)
  if (state.contentPart) return state.contentPart
  const part = { type: 'output_text', text: '', annotations: [] }
  msg.content.push(part)
  state.contentPart = part
  state.contentIndex = msg.content.length - 1
  writeEvent(res, state, 'response.content_part.added', {
    item_id: msg.id, output_index: state.outputIndex, content_index: state.contentIndex,
    part: structuredClone(part)
  })
  return part
}

export function onChatCompletionChunk(res, state, chunk) {
  const choice = chunk.choices?.[0]
  if (!choice) return
  const delta = choice.delta || {}
  const finishReason = choice.finish_reason

  if (delta.content) {
    const part = ensureChatContentPart(res, state)
    part.text += delta.content
    writeEvent(res, state, 'response.output_text.delta', {
      item_id: state.messageItem.id, output_index: state.outputIndex,
      content_index: state.contentIndex, delta: delta.content
    })
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function) {
        const item = {
          id: tc.id, type: 'function_call', status: 'in_progress',
          call_id: tc.id, name: tc.function.name || '', arguments: tc.function.arguments || ''
        }
        state.response.output.push(item)
        const idx = state.response.output.length - 1
        writeEvent(res, state, 'response.output_item.added', { output_index: idx, item: structuredClone(item) })
      }
      if (tc.function?.arguments) {
        const lastItem = state.response.output[state.response.output.length - 1]
        if (lastItem?.type === 'function_call') {
          lastItem.arguments += tc.function.arguments
          writeEvent(res, state, 'response.function_call_arguments.delta', {
            item_id: lastItem.id, output_index: state.response.output.length - 1,
            delta: tc.function.arguments
          })
        }
      }
    }
  }

  if (finishReason) {
    if (state.messageItem) {
      state.messageItem.status = 'completed'
      writeEvent(res, state, 'response.output_item.done', {
        output_index: state.outputIndex, item: structuredClone(state.messageItem)
      })
    }
    if (state.contentPart) {
      writeEvent(res, state, 'response.output_text.done', {
        item_id: state.messageItem.id, output_index: state.outputIndex,
        content_index: state.contentIndex, text: state.contentPart.text
      })
      writeEvent(res, state, 'response.content_part.done', {
        item_id: state.messageItem.id, output_index: state.outputIndex,
        content_index: state.contentIndex, part: structuredClone(state.contentPart)
      })
    }
    for (let i = 0; i < state.response.output.length; i++) {
      const item = state.response.output[i]
      if (item.type === 'function_call' && item.status === 'in_progress') {
        item.status = 'completed'
        writeEvent(res, state, 'response.function_call_arguments.done', {
          item_id: item.id, output_index: i, arguments: item.arguments
        })
        writeEvent(res, state, 'response.output_item.done', {
          output_index: i, item: structuredClone(item)
        })
      }
    }
    state.response.status = 'completed'
    state.response.usage = chunk.usage ? {
      input_tokens: chunk.usage.prompt_tokens || 0,
      output_tokens: chunk.usage.completion_tokens || 0,
      total_tokens: chunk.usage.total_tokens || 0
    } : null
    writeEvent(res, state, 'response.completed', { response: structuredClone(state.response) })
  }
}

export async function streamChatCompletionToResponses(upstream, res, body, { provider = 'openai-api' } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...proxyMetaHeaders(res)
  })
  const state = createChatStreamState(body)
  writeEvent(res, state, 'response.created', { response: structuredClone(state.response) })
  writeEvent(res, state, 'response.in_progress', { response: structuredClone(state.response) })

  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data || data === '[DONE]') continue
      try {
        const chunk = JSON.parse(data)
        if (chunk.usage) usage = chunk.usage
        onChatCompletionChunk(res, state, chunk)
      } catch (error) {
        console.error('[codex-proxy] Chat SSE conversion error:', safeErrorText(error))
      }
    }
  }
  if (!res.writableEnded) {
    if (usage) {
      recordUsage(body.model || 'unknown', provider, usage.prompt_tokens || 0, usage.completion_tokens || 0)
      saveStats()
    }
    res.end('data: [DONE]\n\n')
  }
}
