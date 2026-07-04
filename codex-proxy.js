#!/usr/bin/env node
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const PORT = Number(process.env.CODEX_PROXY_PORT || 47892)
const HOST = process.env.CODEX_PROXY_HOST || '127.0.0.1'
const UPSTREAM_URL = process.env.DEEPSEEK_ANTHROPIC_URL || 'https://api.deepseek.com/anthropic/v1/messages'
const CHATGPT_RESPONSES_URL = process.env.CODEX_CHATGPT_RESPONSES_URL || 'https://chatgpt.com/backend-api/codex/responses'
const DEFAULT_MODEL = process.env.CODEX_PROXY_DEFAULT_MODEL || 'deepseek-v4-pro'
const MAX_BODY_BYTES = 16 * 1024 * 1024
const PROXY_DIR = path.dirname(fileURLToPath(import.meta.url))
const THREAD_ROUTES_DIR = process.env.CODEX_PROXY_THREAD_ROUTES_DIR || path.join(PROXY_DIR, 'codex-thread-routes')

const REQUEST_LOG = path.join(os.homedir(), '.claude', 'proxy', 'codex-proxy-requests.log')

try { fs.mkdirSync(THREAD_ROUTES_DIR, { recursive: true }) } catch {}

function requestLog(req, extra = '') {
  const ts = new Date().toISOString()
  const line = `${ts} ${req.method} ${req.url} | UA=${req.headers['user-agent']?.slice(0, 80) || 'none'} | CT=${req.headers['content-type'] || 'none'} | Auth=${req.headers['authorization'] ? 'yes' : 'no'}${extra ? ' | ' + extra : ''}\n`
  try { fs.appendFileSync(REQUEST_LOG, line) } catch {}
}

export function buildModelsResponse(localModels = [], cachedModels = []) {
  const models = []
  const seen = new Set()
  for (const model of [...localModels, ...cachedModels]) {
    const slug = model?.slug || model?.id
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    models.push({ ...model, slug })
  }
  const data = models.map(model => ({
    id: model.slug,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: model.slug === DEFAULT_MODEL ? 'deepseek' : 'openai'
  }))
  return { models, object: 'list', data }
}

export function parseThreadMetadata(body = {}) {
  const raw = body?.client_metadata?.['x-codex-turn-metadata']
    ?? body?.client_metadata?.xCodexTurnMetadata
    ?? body?.metadata?.['x-codex-turn-metadata']
    ?? body?.metadata
    ?? null

  if (!raw) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}

  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function getThreadId(body = {}) {
  const meta = parseThreadMetadata(body)
  return meta.thread_id || meta.threadId || body.thread_id || body.threadId || null
}

export function normalizeRouteModel(model) {
  if (!model || typeof model !== 'string') return null
  const trimmed = model.trim()
  return trimmed ? trimmed : null
}

export function getThreadRouteFile(threadId) {
  if (!threadId) return null
  return path.join(THREAD_ROUTES_DIR, `${threadId}.json`)
}

export function readThreadRoute(threadId) {
  return readThreadRouteState(threadId).model
}

export function readThreadRouteState(threadId) {
  const routeFile = getThreadRouteFile(threadId)
  if (!routeFile) return { model: null, reasoning_effort: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(routeFile, 'utf8'))
    const effort = ['low', 'medium', 'high', 'xhigh'].includes(parsed.reasoning_effort) ? parsed.reasoning_effort : null
    return { model: normalizeRouteModel(parsed.model), reasoning_effort: effort }
  } catch {
    return { model: null, reasoning_effort: null }
  }
}

export function writeThreadRoute(threadId, model, reasoningEffort = null) {
  const routeFile = getThreadRouteFile(threadId)
  if (!routeFile) throw new Error('threadId is required')
  const effort = ['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort) ? reasoningEffort : null
  const payload = {
    thread_id: threadId,
    model: normalizeRouteModel(model),
    reasoning_effort: effort,
    updated_at: new Date().toISOString()
  }
  fs.mkdirSync(THREAD_ROUTES_DIR, { recursive: true })
  fs.writeFileSync(routeFile, JSON.stringify(payload, null, 2))
  return payload
}

export function resolveCodexModel(body = {}) {
  const threadId = getThreadId(body)
  const threadRoute = readThreadRouteState(threadId)
  const threadModel = threadRoute.model
  const bodyModel = normalizeRouteModel(body.model)
  // Native `/model` is the only source of truth. Legacy thread route files are
  // retained only for diagnostics and must never override the request model.
  const model = bodyModel || DEFAULT_MODEL
  const bodyEffort = body?.reasoning?.effort || body?.reasoning_effort || null
  const reasoningEffort = bodyEffort
  return { model, threadId, threadModel, bodyModel, reasoningEffort }
}

export function isChatGptModel(model) {
  return typeof model === 'string' && /^gpt-/i.test(model)
}

function chatGptHeaders(req) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
  // Do not forward x-openai-internal-codex-responses-lite. The mixed catalog
  // includes GPT models that work through the normal Responses path but are
  // rejected when that internal Lite mode reaches the ChatGPT upstream.
  const forwarded = [
    'authorization', 'chatgpt-account-id', 'originator', 'session-id',
    'thread-id', 'user-agent', 'x-client-request-id', 'x-codex-beta-features',
    'x-codex-turn-metadata', 'x-codex-window-id'
  ]
  for (const name of forwarded) {
    const value = req.headers[name]
    if (value) headers[name] = value
  }
  return headers
}

async function pipeResponsesUpstream(upstream, res) {
  const headers = {}
  for (const name of ['content-type', 'cache-control', 'x-request-id', 'openai-processing-ms', 'openai-version']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  res.writeHead(upstream.status, headers)
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
  }
  res.end()
}

function id(prefix = 'resp') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function asText(value) {
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
  return message?.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_use')
}

function hasToolResult(message) {
  return message?.role === 'user' && Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_result')
}

function toolUseIds(message) {
  return (message?.content || []).filter(block => block?.type === 'tool_use' && block.id).map(block => block.id)
}

function toolResultIds(message) {
  return (message?.content || []).filter(block => block?.type === 'tool_result' && block.tool_use_id).map(block => block.tool_use_id)
}

function toolBlockAsText(block, reason = 'missing matching result') {
  if (block?.type === 'tool_use') {
    return {
      type: 'text',
      text: `[Tool call omitted: ${block.name || 'unknown'} (${block.id || 'no id'}), ${reason}.]`
    }
  }
  if (block?.type === 'tool_result') {
    return {
      type: 'text',
      text: `[Tool result omitted: ${block.tool_use_id || 'no id'}, ${reason}.]\n${asText(block.content)}`
    }
  }
  return block
}

function pushSanitizedMessage(messages, message) {
  if (!message?.content?.length) return
  const previous = messages.at(-1)
  // Do not merge across tool-use/tool-result boundaries: Anthropic/DeepSeek
  // requires the user message containing tool_result blocks to immediately
  // follow the assistant message containing the matching tool_use blocks.
  if (
    previous?.role === message.role &&
    !hasToolUse(previous) &&
    !hasToolUse(message) &&
    !hasToolResult(previous) &&
    !hasToolResult(message)
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
        if (block.type !== 'tool_use') {
          normalContent.push(block)
          continue
        }
        // Codex may trim large histories and leave old function_call items
        // without their function_call_output. DeepSeek's Anthropic endpoint
        // rejects that entire request, so keep the transcript readable but
        // remove the structural tool_use marker when its result is missing.
        if (nextResultIds.has(block.id)) matchedToolUses.push(block)
        else normalContent.push(toolBlockAsText(block))
      }
      // Codex can serialize an assistant status message after function_call
      // items but before their outputs. DeepSeek treats content after a
      // tool_use as breaking the required immediate tool_result boundary, so
      // keep all matched tool_use blocks at the end of the assistant message.
      const content = [...normalContent, ...matchedToolUses]
      pushSanitizedMessage(sanitized, { role: 'assistant', content })
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
        if (block.type !== 'tool_result') {
          normalBlocks.push(block)
          continue
        }
        if (expectedIds.has(block.tool_use_id)) matchedResults.push(block)
        else orphanResults.push(toolBlockAsText(block))
      }

      // Put valid tool_result blocks first, as required by strict Anthropic
      // validators, and convert orphan tool_result blocks to plain text.
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

export function responsesToAnthropic(body, effectiveModel = body.model || DEFAULT_MODEL) {
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
        ? {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false
          }
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
    model: body.model || DEFAULT_MODEL,
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
        id: id(`tool${index}`),
        type: isCustom ? 'custom_tool_call' : 'function_call',
        status: 'completed',
        call_id: block.id,
        name: block.name,
        ...(isCustom
          ? { input: asText(block.input?.input ?? block.input) }
          : { arguments: JSON.stringify(block.input || {}) })
      }]
    }
    return []
  })
  response.usage = anthropicUsage(data.usage)
  return response
}

function writeEvent(res, state, type, payload = {}) {
  const event = { type, sequence_number: state.sequence++, ...payload }
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function createStreamState(body, customTools) {
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
  const item = {
    id: id('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: []
  }
  state.messageItem = item
  state.response.output.push(item)
  writeEvent(res, state, 'response.output_item.added', {
    output_index: state.response.output.length - 1, item: structuredClone(item)
  })
  return item
}

function onAnthropicEvent(res, state, event) {
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
        item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: structuredClone(part)
      })
      return
    }
    if (block.type === 'tool_use') {
      const isCustom = state.customTools.has(block.name)
      const item = {
        id: id('tool'), type: isCustom ? 'custom_tool_call' : 'function_call', status: 'in_progress',
        call_id: block.id, name: block.name, ...(isCustom ? { input: '' } : { arguments: '' })
      }
      state.response.output.push(item)
      const outputIndex = state.response.output.length - 1
      state.blocks.set(event.index, { kind: isCustom ? 'custom' : 'function', item, outputIndex, json: '' })
      writeEvent(res, state, 'response.output_item.added', { output_index: outputIndex, item: structuredClone(item) })
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
      if (current.kind === 'custom') {
        // Anthropic streams JSON fragments; wait for a complete object so Codex
        // receives the custom tool's raw input exactly once instead of duplicated fragments.
      } else {
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
    writeEvent(res, state, 'response.completed', { response: structuredClone(state.response) })
    res.end('data: [DONE]\n\n')
  }
}

async function streamAnthropicToResponses(upstream, res, body, customTools) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
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
        console.error('[codex-proxy] SSE conversion error:', error.message)
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

function sendJson(res, status, data) {
  const text = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function handleControlRoute(req, res, url) {
  const match = url.pathname.match(/^\/control\/threads\/([^/]+)\/route$/)
  if (!match) return false

  const threadId = decodeURIComponent(match[1])
  if (!threadId) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'threadId is required' } })
    return true
  }

  if (req.method === 'GET') {
    const state = readThreadRouteState(threadId)
    return sendJson(res, 200, {
      thread_id: threadId,
      model: state.model,
      reasoning_effort: state.reasoning_effort,
      file: getThreadRouteFile(threadId)
    })
  }

  if (req.method === 'DELETE') {
    const routeFile = getThreadRouteFile(threadId)
    try {
      if (routeFile && fs.existsSync(routeFile)) fs.unlinkSync(routeFile)
    } catch (error) {
      return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
    }
    return sendJson(res, 200, { thread_id: threadId, cleared: true })
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    return sendJson(res, 405, { error: { type: 'invalid_request_error', message: 'Use GET, PUT, POST, or DELETE' } })
  }

  return readJson(req).then(body => {
    const model = normalizeRouteModel(body.model || body.route)
    if (!model) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'model is required' } })
    }
    const payload = writeThreadRoute(threadId, model, body.reasoning_effort || body.effort)
    return sendJson(res, 200, payload)
  }).catch(error => {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(fetchImpl, url, options) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, options)
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) return response
      await response.body?.cancel()
      lastError = new Error(`DeepSeek returned transient HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === 2) throw error
    }
    await delay(500 * (attempt + 1))
  }
  throw lastError
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 16 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createServer({ fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // ── Always log every request for diagnostics ──
    if (req.method === 'GET' && url.pathname === '/health') {
      // Skip health check noise
    } else {
      requestLog(req)
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const ready = Boolean(process.env.DEEPSEEK_API_KEY)
      return sendJson(res, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable', provider: 'deepseek', port: PORT })
    }

    if (req.method === 'HEAD' && (url.pathname === '/v1' || url.pathname === '/v1/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end()
    }

    if (/^\/control\/threads\/[^/]+\/route$/.test(url.pathname)) {
      await handleControlRoute(req, res, url)
      return
    }

    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      let localModels = []
      try {
        localModels = JSON.parse(fs.readFileSync(path.join(PROXY_DIR, 'codex-models.json'), 'utf8')).models || []
      } catch {}
      // The TUI stays on one stable proxy model. The models skill selects the
      // actual upstream per thread, so cached native models are intentionally hidden.
      return sendJson(res, 200, buildModelsResponse(localModels))
    }

    // ── Responses API: POST /v1/responses ──
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname.endsWith('/responses'))) {
      try {
        const body = await readJson(req)
        const resolved = resolveCodexModel(body)
        requestLog(req, `model=${resolved.model} effort=${resolved.reasoningEffort || 'default'} thread=${resolved.threadId || 'none'} stream=${body.stream}`)
        if (isChatGptModel(resolved.model)) {
          if (!req.headers.authorization || !req.headers['chatgpt-account-id']) {
            return sendJson(res, 401, {
              error: { type: 'authentication_error', message: 'ChatGPT subscription headers were not provided by Codex' }
            })
          }
          const upstream = await fetchImpl(CHATGPT_RESPONSES_URL, {
            method: 'POST',
            headers: chatGptHeaders(req),
            body: JSON.stringify({
              ...body,
              model: resolved.model,
              ...(resolved.reasoningEffort ? { reasoning: { ...(body.reasoning || {}), effort: resolved.reasoningEffort } } : {})
            }),
            signal: AbortSignal.timeout(300000)
          })
          return pipeResponsesUpstream(upstream, res)
        }
        if (!process.env.DEEPSEEK_API_KEY) {
          return sendJson(res, 503, { error: { type: 'authentication_error', message: 'DEEPSEEK_API_KEY is not set' } })
        }
        const { request, customTools } = responsesToAnthropic(body, resolved.model)
        const upstream = await fetchWithRetry(fetchImpl, UPSTREAM_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.DEEPSEEK_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(300000)
        })
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 2000)
          return sendJson(res, upstream.status, {
            error: { type: 'upstream_error', message: `DeepSeek returned HTTP ${upstream.status}`, detail }
          })
        }
        if (body.stream) return streamAnthropicToResponses(upstream, res, { ...body, model: resolved.model }, customTools)
        const data = await upstream.json()
        return sendJson(res, 200, anthropicToResponse(data, { ...body, model: resolved.model }, customTools))
      } catch (error) {
        console.error('[codex-proxy] request failed:', error.message, error.cause?.message || '')
        if (!res.headersSent) {
          return sendJson(res, 502, { error: { type: 'proxy_error', message: error.message } })
        }
        if (!res.writableEnded) res.end()
      }
      return
    }

    // ── Responses API: GET /v1/responses/{id} ──
    const respMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/)
    if (req.method === 'GET' && respMatch) {
      requestLog(req, `retrieve-response id=${respMatch[1]}`)
      return sendJson(res, 501, {
        error: {
          type: 'not_implemented',
          message: 'Stored response retrieval is not supported by this stateless proxy.'
        }
      })
    }

    // ── Chat Completions API: POST /v1/chat/completions ──
    // If Codex falls back to Chat Completions for custom providers, handle it
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      if (!process.env.DEEPSEEK_API_KEY) {
        return sendJson(res, 503, { error: { type: 'authentication_error', message: 'DEEPSEEK_API_KEY is not set' } })
      }
      try {
        const body = await readJson(req)
        const resolved = resolveCodexModel(body)
        requestLog(req, `chat-completions model=${resolved.model} thread=${resolved.threadId || 'none'} stream=${body.stream}`)
        // Convert Chat Completions format to Anthropic Messages
        const messages = (body.messages || []).map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : c).filter(Boolean) : '')
        }))
        // Flatten string content blocks
        for (const msg of messages) {
          if (typeof msg.content === 'string') msg.content = [{ type: 'text', text: msg.content }]
          if (Array.isArray(msg.content)) {
            msg.content = msg.content.map(c => typeof c === 'string' ? { type: 'text', text: c } : c)
          }
        }
        const request = {
          model: resolved.model,
          max_tokens: body.max_tokens || 8192,
          messages,
          stream: body.stream === true
        }
        if (body.system) request.system = body.system
        if (body.tools && body.tool_choice !== 'none') {
          request.tools = body.tools.map(t => ({
            name: t.function?.name || t.name,
            description: t.function?.description || t.description || '',
            input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
          }))
        }
        if (body.temperature != null) request.temperature = body.temperature

        const upstream = await fetchWithRetry(fetchImpl, UPSTREAM_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.DEEPSEEK_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(300000)
        })
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 2000)
          return sendJson(res, upstream.status, {
            error: { type: 'upstream_error', message: `DeepSeek returned HTTP ${upstream.status}`, detail }
          })
        }
        if (body.stream) {
          // Return Anthropic SSE directly; convert to OpenAI SSE format
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
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
              try {
                const ev = JSON.parse(data)
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                const chunk = {
                  id: ev.index != null ? `chatcmpl-${ev.index}` : 'chatcmpl-0',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: resolved.model,
                  choices: [{ index: ev.index || 0, delta: { content: ev.delta.text }, finish_reason: null }]
                }
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                } else if (ev.type === 'message_stop') {
                  const chunk = {
                    id: 'chatcmpl-final',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: resolved.model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                  }
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                  res.end('data: [DONE]\n\n')
                }
              } catch { /* skip malformed events */ }
            }
          }
          if (!res.writableEnded) res.end('data: [DONE]\n\n')
          return
        }
        // Non-streaming Chat Completions response
        const data = await upstream.json()
        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
        return sendJson(res, 200, {
          id: data.id || id('chatcmpl'),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: resolved.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: data.stop_reason || 'stop'
          }],
          usage: {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
          }
        })
      } catch (error) {
        console.error('[codex-proxy] chat/completions failed:', error.message)
        if (!res.headersSent) {
          return sendJson(res, 502, { error: { type: 'proxy_error', message: error.message } })
        }
        if (!res.writableEnded) res.end()
      }
      return
    }

    // ── Everything else → log and 404 ──
    requestLog(req, `REJECTED-404 (no handler)`)
    return sendJson(res, 404, { error: { type: 'invalid_request_error', message: `Not found: ${req.method} ${url.pathname}` } })
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  createServer().listen(PORT, HOST, () => {
    console.log(`[codex-proxy] listening on http://${HOST}:${PORT}`)
  })
}
