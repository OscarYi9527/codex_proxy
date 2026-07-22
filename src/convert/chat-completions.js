// Responses API ↔ Chat Completions API format conversion
// Used when upstream only supports /v1/chat/completions (OpenAI API channel)

import { id, asText } from './anthropic.js'

function contentBlockToText(content) {
  if (typeof content === 'string') return content
  if (content?.text) return content.text
  if (content?.type === 'output_text' || content?.type === 'input_text') return content.text || ''
  return ''
}

function serializeArguments(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return '{}'
  return JSON.stringify(value)
}

function appendToolCall(messages, toolCall) {
  const previous = messages.at(-1)
  if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls) && previous.content == null) {
    previous.tool_calls.push(toolCall)
    return
  }
  messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })
}

function responsesInputToMessages(input) {
  const messages = []
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : (Array.isArray(input) ? input : [])

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message' || (!item.type && item.role)) {
      const role = ['assistant', 'developer', 'system'].includes(item.role)
        ? item.role
        : 'user'
      let content
      if (typeof item.content === 'string') {
        content = item.content
      } else if (Array.isArray(item.content)) {
        content = item.content.map(contentBlockToText).filter(Boolean).join('\n')
      } else {
        content = ''
      }
      messages.push({ role, content })
      continue
    }
    if (item.type === 'function_call') {
      appendToolCall(messages, {
        id: item.call_id || item.id || id('call'),
        type: 'function',
        function: { name: item.name, arguments: serializeArguments(item.arguments) }
      })
      continue
    }
    if (item.type === 'custom_tool_call') {
      appendToolCall(messages, {
        id: item.call_id || item.id || id('call'),
        type: 'function',
        function: {
          name: item.name,
          arguments: JSON.stringify({ input: typeof item.input === 'string' ? item.input : asText(item.input) })
        }
      })
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.tool_call_id || item.id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '')
      })
    }
  }
  return messages
}

export function customToolNames(body = {}) {
  const names = new Set((body.tools || [])
    .filter(tool => tool?.type === 'custom' && tool.name)
    .map(tool => tool.name))
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === 'custom_tool_call' && item.name) names.add(item.name)
    }
  }
  return names
}

export function customToolInput(value) {
  if (value && typeof value === 'object') {
    return asText(Object.hasOwn(value, 'input') ? value.input : value)
  }
  if (typeof value !== 'string') return asText(value)
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'input')) {
      return asText(parsed.input)
    }
    return typeof parsed === 'string' ? parsed : asText(parsed)
  } catch {
    return value
  }
}

export function responsesToChatCompletions(body, upstreamModel) {
  const messages = []
  const instructions = asText(body.instructions)
  if (instructions) messages.push({ role: 'system', content: instructions })

  const inputMessages = responsesInputToMessages(body.input)
  messages.push(...inputMessages)
  if (!messages.length) messages.push({ role: 'user', content: '' })

  const request = {
    model: upstreamModel,
    messages,
    max_tokens: body.max_output_tokens || 4096,
    stream: body.stream === true
  }
  if (request.stream) request.stream_options = { include_usage: true }
  if (body.temperature != null) request.temperature = body.temperature
  if (body.top_p != null) request.top_p = body.top_p

  if (body.tools && body.tool_choice !== 'none') {
    request.tools = body.tools.map(tool => {
      if (tool.type === 'custom') {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || `Codex tool: ${tool.name}`,
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false
            }
          }
        }
      }
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      }
    })
    if (body.tool_choice) {
      if (body.tool_choice === 'required') request.tool_choice = 'required'
      else if (body.tool_choice === 'auto') request.tool_choice = 'auto'
      else if (body.tool_choice?.name) {
        request.tool_choice = { type: 'function', function: { name: body.tool_choice.name } }
      }
    }
  }
  return request
}

export function chatCompletionToResponse(data, originalBody) {
  const choice = data.choices?.[0] || {}
  const message = choice.message || {}
  const incompleteReason = choice.finish_reason === 'length'
    ? 'max_output_tokens'
    : (choice.finish_reason === 'content_filter' ? 'content_filter' : null)
  const customTools = customToolNames(originalBody)
  const response = {
    id: data.id || id('resp'),
    object: 'response',
    created_at: data.created || Math.floor(Date.now() / 1000),
    status: incompleteReason ? 'incomplete' : 'completed',
    model: originalBody.model || data.model,
    output: [],
    usage: null
  }
  if (incompleteReason) response.incomplete_details = { reason: incompleteReason }

  if (message.content) {
    response.output.push({
      id: id('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }]
    })
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const name = tc.function?.name || ''
      const isCustom = customTools.has(name)
      const callId = tc.id || id('call')
      response.output.push(isCustom
        ? {
            id: callId,
            type: 'custom_tool_call',
            status: 'completed',
            call_id: callId,
            name,
            input: customToolInput(tc.function?.arguments)
          }
        : {
            id: callId,
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name,
            arguments: serializeArguments(tc.function?.arguments)
          })
    }
  }

  if (data.usage) {
    const inputTokens = data.usage.prompt_tokens || 0
    const outputTokens = data.usage.completion_tokens || 0
    response.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: data.usage.total_tokens ?? (inputTokens + outputTokens)
    }
  }

  return response
}
