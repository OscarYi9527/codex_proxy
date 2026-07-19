// Responses API ↔ Chat Completions API format conversion
// Used when upstream only supports /v1/chat/completions (OpenAI API channel)

import { id, asText } from './anthropic.js'

function contentBlockToText(content) {
  if (typeof content === 'string') return content
  if (content?.text) return content.text
  if (content?.type === 'output_text' || content?.type === 'input_text') return content.text || ''
  return ''
}

function responsesInputToMessages(input) {
  const messages = []
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : (Array.isArray(input) ? input : [])

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message' || (!item.type && item.role)) {
      const role = item.role === 'assistant' ? 'assistant' : 'user'
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
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || id('call'),
          type: 'function',
          function: { name: item.name, arguments: JSON.stringify(item.arguments || {}) }
        }]
      })
      continue
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '')
      })
    }
  }
  return messages
}

function usesMaxCompletionTokens(model) {
  return /^(?:gpt-5|o[134])(?:$|[-_.])/i.test(String(model || ''))
}

function requiresDisabledReasoningForTools(model) {
  return /^gpt-5[._-]6(?:$|[-_.])/i.test(String(model || ''))
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function convertTool(tool) {
  const source = asRecord(tool)
  if (!source) return null
  const nestedFunction = asRecord(source.function)
  const name = typeof source.name === 'string' && source.name
    ? source.name
    : (typeof nestedFunction?.name === 'string' ? nestedFunction.name : '')

  // Chat Completions only accepts named function tools. Responses built-ins
  // such as web search have no function name and cannot be represented on
  // this compatibility route; omit them instead of emitting an invalid
  // tools[n].function object that the upstream rejects.
  if (!name) return null

  if (source.type === 'custom') {
    return {
      type: 'function',
      function: {
        name,
        description: source.description || `Codex tool: ${name}`,
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
      name,
      description: source.description || nestedFunction?.description || '',
      parameters:
        source.parameters ||
        nestedFunction?.parameters ||
        { type: 'object', properties: {} }
    }
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
    stream: body.stream === true
  }
  const maxOutputTokens = body.max_output_tokens || 4096
  if (usesMaxCompletionTokens(upstreamModel)) {
    request.max_completion_tokens = maxOutputTokens
  } else {
    request.max_tokens = maxOutputTokens
  }
  if (body.temperature != null) request.temperature = body.temperature
  if (body.top_p != null) request.top_p = body.top_p

  if (Array.isArray(body.tools) && body.tool_choice !== 'none') {
    const tools = body.tools.map(convertTool).filter(Boolean)
    if (tools.length) {
      request.tools = tools

      // GPT-5.6 Chat Completions rejects function tools while reasoning is
      // enabled (including the model's default reasoning effort). Explicitly
      // disable reasoning on this compatibility route; native Responses
      // requests keep their requested reasoning level.
      if (requiresDisabledReasoningForTools(upstreamModel)) {
        request.reasoning_effort = 'none'
      }
    }
    if (tools.length && body.tool_choice) {
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
  const response = {
    id: data.id || id('resp'),
    object: 'response',
    created_at: data.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: originalBody.model || data.model,
    output: [],
    usage: null
  }

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
      response.output.push({
        id: tc.id || id('tool'),
        type: 'function_call',
        status: 'completed',
        call_id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}'
      })
    }
  }

  if (data.usage) {
    response.usage = {
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0
    }
  }

  return response
}
