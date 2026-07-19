// Responses API ↔ Anthropic Messages protocol conversion
// Used for DeepSeek upstream (Anthropic-compatible API)

import { recordUsage, saveStats } from '../stats.js'
import { responsesFunctionCallItemId } from './tool-ids.js'


export function id(prefix = 'resp') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function asText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value)
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value || '{}') } catch { return { input: asText(value) } }
}

function pushMessage(messages, role, blocks) {
  if (!blocks.length) return
  const previous = messages.at(-1)
  if (previous?.role === role) previous.content.push(...blocks)
  else messages.push({ role, content: blocks })
}

function contentToAnthropic(content, role) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap(part => {
    if (typeof part === 'string') return [{ type: 'text', text: part }]
    if (['input_text', 'output_text', 'text'].includes(part?.type)) {
      return [{ type: 'text', text: part.text || '' }]
    }
    if (part?.type === 'refusal') return [{ type: 'text', text: part.refusal || '' }]
    if (part?.type === 'input_image') {
      throw new Error(`DeepSeek proxy does not support ${role} image input`)
    }
    return []
  })
}

function hasToolUse(message) {
  return message?.role === 'assistant' && Array.isArray(message.content)
    && message.content.some(block => block?.type === 'tool_use')
}

function hasToolResult(message) {
  return message?.role === 'user' && Array.isArray(message.content)
    && message.content.some(block => block?.type === 'tool_result')
}

function toolUseIds(message) {
  return (message?.content || []).filter(block => block?.type === 'tool_use' && block.id).map(block => block.id)
}

function toolResultIds(message) {
  return (message?.content || []).filter(block => block?.type === 'tool_result' && block.tool_use_id).map(block => block.tool_use_id)
}

function toolBlockAsText(block, reason = 'missing matching result') {
  if (block?.type === 'tool_use') {
    return { type: 'text', text: `[Tool call omitted: ${block.name || 'unknown'} (${block.id || 'no id'}), ${reason}.]` }
  }
  if (block?.type === 'tool_result') {
    return { type: 'text', text: `[Tool result omitted: ${block.tool_use_id || 'no id'}, ${reason}.]\n${asText(block.content)}` }
  }
  return block
}

function pushSanitizedMessage(messages, message) {
  if (!message?.content?.length) return
  const previous = messages.at(-1)
  if (
    previous?.role === message.role &&
    !hasToolUse(previous) && !hasToolUse(message) &&
    !hasToolResult(previous) && !hasToolResult(message)
  ) {
    previous.content.push(...message.content)
  } else {
    messages.push(message)
  }
}

export function sanitizeAnthropicMessages(messages = []) {
  const sanitized = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || !Array.isArray(message.content)) continue

    if (message.role === 'assistant') {
      const ids = toolUseIds(message)
      if (!ids.length) {
        pushSanitizedMessage(sanitized, { role: 'assistant', content: message.content.filter(Boolean) })
        continue
      }
      const next = messages[i + 1]
      const nextResultIds = new Set(next?.role === 'user' ? toolResultIds(next) : [])
      const normalContent = []
      const matchedToolUses = []
      for (const block of message.content) {
        if (!block) continue
        if (block.type !== 'tool_use') { normalContent.push(block); continue }
        if (nextResultIds.has(block.id)) matchedToolUses.push(block)
        else normalContent.push(toolBlockAsText(block))
      }
      pushSanitizedMessage(sanitized, { role: 'assistant', content: [...normalContent, ...matchedToolUses] })
      continue
    }

    if (message.role === 'user') {
      const previous = sanitized.at(-1)
      const expectedIds = new Set(toolUseIds(previous))
      const matchedResults = []
      const normalBlocks = []
      const orphanResults = []
      for (const block of message.content) {
        if (!block) continue
        if (block.type !== 'tool_result') { normalBlocks.push(block); continue }
        if (expectedIds.has(block.tool_use_id)) matchedResults.push(block)
        else orphanResults.push(toolBlockAsText(block))
      }
      pushSanitizedMessage(sanitized, {
        role: 'user',
        content: [...matchedResults, ...normalBlocks, ...orphanResults]
      })
      continue
    }
    pushSanitizedMessage(sanitized, { role: message.role, content: message.content.filter(Boolean) })
  }
  return sanitized.length ? sanitized : [{ role: 'user', content: [{ type: 'text', text: '' }] }]
}

export function responsesToAnthropic(body, effectiveModel) {
  const messages = []
  const customTools = new Set()
  const input = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : (Array.isArray(body.input) ? body.input : [])

  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message' || (!item.type && item.role)) {
      const role = item.role === 'assistant' ? 'assistant' : 'user'
      pushMessage(messages, role, contentToAnthropic(item.content, role))
      continue
    }
    if (item.type === 'function_call') {
      pushMessage(messages, 'assistant', [{
        type: 'tool_use',
        id: item.call_id || item.id || id('call'),
        name: item.name,
        input: parseArguments(item.arguments)
      }])
      continue
    }
    if (item.type === 'custom_tool_call') {
      customTools.add(item.name)
      pushMessage(messages, 'assistant', [{
        type: 'tool_use',
        id: item.call_id || item.id || id('call'),
        name: item.name,
        input: { input: item.input || '' }
      }])
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      pushMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: item.call_id || item.id || item.tool_call_id,
        content: asText(item.output)
      }])
    }
  }

  const tools = (body.tools || []).flatMap(tool => {
    if (!tool?.name) return []
    if (tool.type === 'custom') customTools.add(tool.name)
    return [{
      name: tool.name,
      description: tool.description || `Codex tool: ${tool.name}`,
      input_schema: tool.type === 'custom'
        ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
        : (tool.parameters || { type: 'object', properties: {} })
    }]
  })

  const request = {
    model: effectiveModel,
    max_tokens: body.max_output_tokens || 8192,
    messages: sanitizeAnthropicMessages(messages),
    stream: body.stream === true
  }
  const instructions = asText(body.instructions)
  if (instructions) request.system = instructions
  if (tools.length && body.tool_choice !== 'none') request.tools = tools
  if (body.temperature != null) request.temperature = body.temperature
  if (body.tool_choice === 'required') request.tool_choice = { type: 'any' }
  else if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.name) {
    request.tool_choice = { type: 'tool', name: body.tool_choice.name }
  }
  return { request, customTools }
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

function anthropicUsage(usage = {}) {
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  return { input_tokens: input, output_tokens: output, total_tokens: input + output }
}

export function anthropicToResponse(data, originalBody, customTools = new Set()) {
  const response = responseShell(originalBody, 'completed')
  response.id = data.id || response.id
  response.output = (data.content || []).flatMap((block, index) => {
    if (block.type === 'text') {
      return [{
        id: id(`msg${index}`), type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: block.text || '', annotations: [] }]
      }]
    }
    if (block.type === 'tool_use') {
      const isCustom = customTools.has(block.name)
      return [{
        // Responses validates function_call item IDs as `fc_*`; keep the upstream ID as call_id.
        id: isCustom ? id(`tool${index}`) : responsesFunctionCallItemId(block.id),
        type: isCustom ? 'custom_tool_call' : 'function_call',
        status: 'completed',
        call_id: block.id,
        name: block.name,
        ...(isCustom ? { input: asText(block.input?.input ?? block.input) } : { arguments: JSON.stringify(block.input || {}) })
      }]
    }
    return []
  })
  response.usage = anthropicUsage(data.usage)
  return response
}
