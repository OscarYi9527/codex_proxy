// Streaming conversion helpers
// Anthropic SSE -> Responses SSE and Chat Completions SSE -> Responses SSE

import { id } from './anthropic.js'
import { customToolInput, customToolNames } from './chat-completions.js'
import { SSEDecoder } from './sse.js'
import { recordUsage, saveStats } from '../stats.js'
import { proxyMetaHeaders } from '../server-utils.js'
import { safeErrorText } from '../logger.js'

function responseOpen(res) {
  return !res.writableEnded && !res.destroyed && !res.closed
}

export function writeEvent(res, state, type, payload = {}) {
  if (!responseOpen(res)) return false
  const event = { type, sequence_number: state.sequence++, ...payload }
  const accepted = res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
  if (!accepted) state.backpressured = true
  return accepted
}

async function waitForFrameWrites(res, state) {
  if (!responseOpen(res)) return false
  if (!state.backpressured && !res.writableNeedDrain) return true
  if (typeof res.once !== 'function') {
    state.backpressured = false
    return true
  }

  await new Promise(resolve => {
    const cleanup = () => {
      res.off?.('drain', onDrain)
      res.off?.('close', onClose)
      res.off?.('error', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      resolve()
    }
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onClose)
    if (!responseOpen(res)) onClose()
    else if (typeof res.writableNeedDrain === 'boolean' && !res.writableNeedDrain) onDrain()
  })
  state.backpressured = false
  return responseOpen(res)
}

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

function failResponse(res, state, code, message) {
  if (state.terminal) return
  state.response.status = 'failed'
  state.response.error = { code, message }
  writeEvent(res, state, 'response.failed', { response: structuredClone(state.response) })
  state.terminal = true
}

function finishWireStream(res) {
  if (responseOpen(res)) res.end('data: [DONE]\n\n')
}

function isErrorEvent(frame, parsed) {
  return frame.event === 'error' || parsed?.type === 'error' || parsed?.error
}

function upstreamErrorMessage(parsed) {
  return parsed?.error?.message || parsed?.message || 'Upstream returned a streaming error'
}

// -- Anthropic SSE -> Responses SSE ----------------------------------------

function anthropicUsage(usage = {}) {
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  return { input_tokens: input, output_tokens: output, total_tokens: input + output }
}

export function createStreamState(body, customTools = new Set()) {
  return {
    sequence: 0,
    backpressured: false,
    terminal: false,
    response: responseShell(body),
    customTools,
    blocks: new Map(),
    messageItem: null,
    messageDone: false,
    stopReason: null,
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

function finishAnthropicMessage(res, state) {
  if (!state.messageItem || state.messageDone) return
  state.messageItem.status = 'completed'
  state.messageDone = true
  writeEvent(res, state, 'response.output_item.done', {
    output_index: state.response.output.indexOf(state.messageItem),
    item: structuredClone(state.messageItem)
  })
}

function completeAnthropicResponse(res, state) {
  if (state.terminal) return
  finishAnthropicMessage(res, state)
  const incompleteReason = state.stopReason === 'max_tokens'
    ? 'max_output_tokens'
    : (state.stopReason === 'content_filter' || state.stopReason === 'refusal' ? 'content_filter' : null)
  state.response.status = incompleteReason ? 'incomplete' : 'completed'
  state.response.usage = state.usage
  if (incompleteReason) state.response.incomplete_details = { reason: incompleteReason }
  recordUsage(state.response.model, 'deepseek', state.usage.input_tokens, state.usage.output_tokens)
  saveStats()
  writeEvent(res, state, incompleteReason ? 'response.incomplete' : 'response.completed', {
    response: structuredClone(state.response)
  })
  state.terminal = true
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
      const initialJson = block.input && Object.keys(block.input).length
        ? JSON.stringify(block.input)
        : ''
      state.blocks.set(event.index, {
        kind: isCustom ? 'custom' : 'function',
        item,
        outputIndex,
        json: initialJson
      })
      if (!isCustom) item.arguments = initialJson
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
      current.item.input = customToolInput(current.json)
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
    state.stopReason = event.delta?.stop_reason || state.stopReason
    state.usage = anthropicUsage({
      input_tokens: state.usage.input_tokens,
      output_tokens: event.usage?.output_tokens ?? state.usage.output_tokens
    })
    return
  }
  if (type === 'message_stop') completeAnthropicResponse(res, state)
}

export async function streamAnthropicToResponses(upstream, res, body, customTools = new Set()) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...proxyMetaHeaders(res)
  })
  const state = createStreamState(body, customTools)
  const decoder = new SSEDecoder()
  let stopReading = false

  const processFrame = frame => {
    const data = frame.data
    if (!data || data.trim() === '[DONE]') return data.trim() === '[DONE]'
    if (frame.event === 'error') {
      try {
        const parsed = JSON.parse(data)
        failResponse(res, state, 'upstream_error', upstreamErrorMessage(parsed))
      } catch {
        failResponse(res, state, 'upstream_error', data)
      }
      return false
    }
    try {
      const parsed = JSON.parse(data)
      if (isErrorEvent(frame, parsed)) {
        failResponse(res, state, 'upstream_error', upstreamErrorMessage(parsed))
      } else {
        onAnthropicEvent(res, state, parsed)
      }
    } catch (error) {
      console.error('[codex-proxy] SSE conversion error:', safeErrorText(error))
      failResponse(res, state, 'invalid_upstream_event', 'Upstream returned an invalid streaming event')
    }
    return false
  }

  let streamError = null
  try {
    for await (const chunk of upstream.body) {
      for (const frame of decoder.push(chunk)) {
        const doneMarker = processFrame(frame)
        if (!await waitForFrameWrites(res, state)) return
        if (state.terminal || doneMarker) {
          stopReading = true
          break
        }
      }
      if (stopReading) break
    }

    if (!stopReading) {
      for (const frame of decoder.end()) {
        const doneMarker = processFrame(frame)
        if (!await waitForFrameWrites(res, state)) return
        if (state.terminal || doneMarker) break
      }
    }
  } catch (error) {
    streamError = error
    console.error('[codex-proxy] Anthropic stream read error:', safeErrorText(error))
  }

  if (!state.terminal && responseOpen(res)) {
    failResponse(
      res,
      state,
      streamError ? 'upstream_stream_error' : 'upstream_closed',
      streamError ? 'Upstream stream failed before completion' : 'Upstream stream ended unexpectedly'
    )
    if (!await waitForFrameWrites(res, state)) return
  }
  finishWireStream(res)
}

// -- Chat Completions SSE -> Responses SSE --------------------------------

function chatUsage(usage = {}) {
  const input = usage.prompt_tokens || 0
  const output = usage.completion_tokens || 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.total_tokens ?? (input + output)
  }
}

export function createChatStreamState(body) {
  return {
    sequence: 0,
    backpressured: false,
    terminal: false,
    response: responseShell(body),
    customTools: customToolNames(body),
    messageItem: null,
    contentPart: null,
    outputIndex: -1,
    contentIndex: -1,
    toolCallsByIndex: new Map(),
    toolCallsById: new Map(),
    anonymousToolIndex: 0,
    outputFinalized: false,
    finishReason: null,
    usage: null
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
  const message = ensureChatMessage(res, state)
  if (state.contentPart) return state.contentPart
  const part = { type: 'output_text', text: '', annotations: [] }
  message.content.push(part)
  state.contentPart = part
  state.contentIndex = message.content.length - 1
  writeEvent(res, state, 'response.content_part.added', {
    item_id: message.id, output_index: state.outputIndex, content_index: state.contentIndex,
    part: structuredClone(part)
  })
  return part
}

function existingToolCall(state, toolCall) {
  if (toolCall.index != null) {
    const byIndex = state.toolCallsByIndex.get(String(toolCall.index))
    if (byIndex) return byIndex
  }
  if (toolCall.id) {
    const byId = state.toolCallsById.get(toolCall.id)
    if (byId) return byId
  }
  if (toolCall.index == null && !toolCall.id && state.toolCallsByIndex.size === 1) {
    return state.toolCallsByIndex.values().next().value
  }
  return null
}

function createToolCall(res, state, toolCall) {
  const callId = toolCall.id || id('call')
  const item = {
    id: toolCall.id || id('tool'),
    type: 'function_call',
    status: 'in_progress',
    call_id: callId,
    name: '',
    arguments: ''
  }
  state.response.output.push(item)
  const record = {
    item,
    outputIndex: state.response.output.length - 1,
    rawArguments: '',
    isCustom: false,
    announced: false
  }
  const indexKey = toolCall.index != null
    ? String(toolCall.index)
    : `anonymous:${state.anonymousToolIndex++}`
  state.toolCallsByIndex.set(indexKey, record)
  if (toolCall.id) state.toolCallsById.set(toolCall.id, record)
  return record
}

function announceToolCall(res, state, record) {
  if (record.announced) return
  record.isCustom = state.customTools.has(record.item.name)
  if (record.isCustom) {
    record.item.type = 'custom_tool_call'
    delete record.item.arguments
    record.item.input = ''
  } else {
    record.item.arguments = record.rawArguments
  }
  writeEvent(res, state, 'response.output_item.added', {
    output_index: record.outputIndex,
    item: structuredClone(record.item)
  })
  if (!record.isCustom && record.rawArguments) {
    writeEvent(res, state, 'response.function_call_arguments.delta', {
      item_id: record.item.id,
      output_index: record.outputIndex,
      delta: record.rawArguments
    })
  }
  record.announced = true
}

function updateToolCall(res, state, toolCall) {
  const record = existingToolCall(state, toolCall) || createToolCall(res, state, toolCall)
  const name = toolCall.function?.name
  if (name && !record.announced) {
    if (!record.item.name || name.startsWith(record.item.name)) {
      record.item.name = name
    } else if (!record.item.name.endsWith(name)) {
      record.item.name += name
    }
  }
  if (toolCall.id && !state.toolCallsById.has(toolCall.id)) {
    state.toolCallsById.set(toolCall.id, record)
    record.item.call_id = toolCall.id
  }

  const argumentDelta = toolCall.function?.arguments
  const hasArgumentField = Object.hasOwn(toolCall.function || {}, 'arguments')
  if (
    !record.announced &&
    record.item.name &&
    hasArgumentField
  ) {
    announceToolCall(res, state, record)
  }
  if (argumentDelta != null && argumentDelta !== '') {
    const text = typeof argumentDelta === 'string' ? argumentDelta : JSON.stringify(argumentDelta)
    record.rawArguments += text
    if (record.announced && !record.isCustom) {
      record.item.arguments += text
      writeEvent(res, state, 'response.function_call_arguments.delta', {
        item_id: record.item.id,
        output_index: record.outputIndex,
        delta: text
      })
    }
  }
}

function finalizeChatOutput(res, state) {
  if (state.outputFinalized) return
  state.outputFinalized = true

  if (state.contentPart) {
    writeEvent(res, state, 'response.output_text.done', {
      item_id: state.messageItem.id,
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      text: state.contentPart.text
    })
    writeEvent(res, state, 'response.content_part.done', {
      item_id: state.messageItem.id,
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      part: structuredClone(state.contentPart)
    })
  }
  if (state.messageItem) {
    state.messageItem.status = 'completed'
    writeEvent(res, state, 'response.output_item.done', {
      output_index: state.outputIndex,
      item: structuredClone(state.messageItem)
    })
  }

  const records = [...state.toolCallsByIndex.values()]
    .filter((record, index, all) => all.indexOf(record) === index)
    .sort((left, right) => left.outputIndex - right.outputIndex)
  for (const record of records) {
    announceToolCall(res, state, record)
    if (record.isCustom) {
      record.item.input = customToolInput(record.rawArguments)
      writeEvent(res, state, 'response.custom_tool_call_input.delta', {
        item_id: record.item.id,
        output_index: record.outputIndex,
        delta: record.item.input
      })
      writeEvent(res, state, 'response.custom_tool_call_input.done', {
        item_id: record.item.id,
        output_index: record.outputIndex,
        input: record.item.input
      })
    } else {
      writeEvent(res, state, 'response.function_call_arguments.done', {
        item_id: record.item.id,
        output_index: record.outputIndex,
        arguments: record.item.arguments
      })
    }
    record.item.status = 'completed'
    writeEvent(res, state, 'response.output_item.done', {
      output_index: record.outputIndex,
      item: structuredClone(record.item)
    })
  }
}

export function onChatCompletionChunk(res, state, chunk) {
  if (chunk.usage) state.usage = chatUsage(chunk.usage)
  const choice = chunk.choices?.[0]
  if (!choice) return
  const delta = choice.delta || {}

  if (typeof delta.content === 'string' && delta.content) {
    const part = ensureChatContentPart(res, state)
    part.text += delta.content
    writeEvent(res, state, 'response.output_text.delta', {
      item_id: state.messageItem.id,
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      delta: delta.content
    })
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const toolCall of delta.tool_calls) updateToolCall(res, state, toolCall)
  }

  if (choice.finish_reason != null) {
    state.finishReason = choice.finish_reason
    finalizeChatOutput(res, state)
  }
}

function completeChatResponse(res, state) {
  if (state.terminal) return
  if (state.finishReason == null) {
    failResponse(res, state, 'upstream_closed', 'Upstream stream ended before a finish reason')
    return
  }
  finalizeChatOutput(res, state)
  const incompleteReason = state.finishReason === 'length'
    ? 'max_output_tokens'
    : (state.finishReason === 'content_filter' ? 'content_filter' : null)
  state.response.status = incompleteReason ? 'incomplete' : 'completed'
  state.response.usage = state.usage
  if (incompleteReason) state.response.incomplete_details = { reason: incompleteReason }
  writeEvent(res, state, incompleteReason ? 'response.incomplete' : 'response.completed', {
    response: structuredClone(state.response)
  })
  state.terminal = true
}

export async function streamChatCompletionToResponses(upstream, res, body, { provider = 'openai-api' } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...proxyMetaHeaders(res)
  })
  const state = createChatStreamState(body)
  const decoder = new SSEDecoder()
  writeEvent(res, state, 'response.created', { response: structuredClone(state.response) })
  writeEvent(res, state, 'response.in_progress', { response: structuredClone(state.response) })
  if (!await waitForFrameWrites(res, state)) return

  let sawDone = false
  let stopReading = false
  const processFrame = frame => {
    const data = frame.data
    if (!data) return
    if (data.trim() === '[DONE]') {
      sawDone = true
      completeChatResponse(res, state)
      return
    }
    if (frame.event === 'error') {
      try {
        const parsed = JSON.parse(data)
        failResponse(res, state, 'upstream_error', upstreamErrorMessage(parsed))
      } catch {
        failResponse(res, state, 'upstream_error', data)
      }
      return
    }
    try {
      const parsed = JSON.parse(data)
      if (isErrorEvent(frame, parsed)) {
        failResponse(res, state, 'upstream_error', upstreamErrorMessage(parsed))
      } else {
        onChatCompletionChunk(res, state, parsed)
      }
    } catch (error) {
      console.error('[codex-proxy] Chat SSE conversion error:', safeErrorText(error))
      failResponse(res, state, 'invalid_upstream_event', 'Upstream returned an invalid streaming event')
    }
  }

  let streamError = null
  try {
    for await (const chunk of upstream.body) {
      for (const frame of decoder.push(chunk)) {
        processFrame(frame)
        if (!await waitForFrameWrites(res, state)) return
        if (state.terminal) {
          stopReading = true
          break
        }
      }
      if (stopReading) break
    }

    if (!stopReading) {
      for (const frame of decoder.end()) {
        processFrame(frame)
        if (!await waitForFrameWrites(res, state)) return
        if (state.terminal) break
      }
    }
  } catch (error) {
    streamError = error
    console.error('[codex-proxy] Chat stream read error:', safeErrorText(error))
  }

  if (!state.terminal && responseOpen(res)) {
    if (streamError) {
      failResponse(res, state, 'upstream_stream_error', 'Upstream stream failed before completion')
    } else if (state.finishReason != null) completeChatResponse(res, state)
    else failResponse(res, state, 'upstream_closed', 'Upstream stream ended before a finish reason')
    if (!await waitForFrameWrites(res, state)) return
  }

  if (state.usage && (sawDone || state.finishReason != null)) {
    recordUsage(body.model || 'unknown', provider, state.usage.input_tokens, state.usage.output_tokens)
    saveStats()
  }
  finishWireStream(res)
}
