// DeepSeek route handler
// Handles all non-gpt, non-openai-api models via Anthropic-compatible API

import { proxyConfig } from '../config.js'
import { requestLog } from '../logger.js'
import { sendJson, readJson, fetchWithRetry, id, setProxyMeta, proxyMetaHeaders } from '../server-utils.js'
import { recordUsage, saveStats } from '../stats.js'
import { responsesToAnthropic, anthropicToResponse } from '../convert/anthropic.js'
import { streamAnthropicToResponses } from '../convert/stream.js'

export async function handleDeepSeek(req, res, body, resolved) {
  setProxyMeta(res, { provider: 'deepseek', model: resolved.model })
  if (!proxyConfig.deepseekApiKey) {
    return sendJson(res, 503, {
      error: { type: 'authentication_error', message: 'DEEPSEEK_API_KEY is not set' }
    })
  }

  const { request, customTools } = responsesToAnthropic(body, resolved.model)
  const upstream = await fetchWithRetry(req.fetchImpl, proxyConfig.upstreamUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': proxyConfig.deepseekApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(request),
    signal: req.clientAbortSignal,
    attemptTimeoutMs: 300000,
    circuitKey: 'deepseek'
  })

  requestLog(req, `model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} deepseek=1 stream=${body.stream} status=${upstream.status}`)

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 2000)
    return sendJson(res, upstream.status, {
      error: { type: 'upstream_error', message: `DeepSeek returned HTTP ${upstream.status}`, detail }
    })
  }

  if (body.stream) {
    return streamAnthropicToResponses(upstream, res, { ...body, model: resolved.model }, customTools)
  }

  const data = await upstream.json()
  recordUsage(resolved.model, 'deepseek', data.usage?.input_tokens, data.usage?.output_tokens)
  saveStats()
  return sendJson(res, 200, anthropicToResponse(data, { ...body, model: resolved.model }, customTools))
}

export async function handleDeepSeekChatCompletions(req, res, body, resolved) {
  setProxyMeta(res, { provider: 'deepseek', model: resolved.model })
  if (!proxyConfig.deepseekApiKey) {
    return sendJson(res, 503, {
      error: { type: 'authentication_error', message: 'DEEPSEEK_API_KEY is not set' }
    })
  }

  // Convert Chat Completions messages to Anthropic Messages
  const messages = (body.messages || []).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : c).filter(Boolean) : '')
  }))

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

  requestLog(req, `chat-completions model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} deepseek=1 stream=${body.stream}`)

  const upstream = await fetchWithRetry(req.fetchImpl, proxyConfig.upstreamUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': proxyConfig.deepseekApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(request),
    signal: req.clientAbortSignal,
    attemptTimeoutMs: 300000,
    circuitKey: 'deepseek'
  })

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 2000)
    return sendJson(res, upstream.status, {
      error: { type: 'upstream_error', message: `DeepSeek returned HTTP ${upstream.status}`, detail }
    })
  }

  if (body.stream) {
    // Convert Anthropic SSE to OpenAI SSE chunks
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...proxyMetaHeaders(res) })
    const decoder = new TextDecoder()
    let buffer = ''
    const streamUsage = { input_tokens: 0, output_tokens: 0 }
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
          if (ev.type === 'message_start' && ev.message?.usage) {
            streamUsage.input_tokens = Number(ev.message.usage.input_tokens || 0)
            streamUsage.output_tokens = Number(ev.message.usage.output_tokens || 0)
          } else if (ev.type === 'message_delta' && ev.usage) {
            streamUsage.output_tokens = Number(ev.usage.output_tokens || streamUsage.output_tokens)
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
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
              id: 'chatcmpl-final', object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model: resolved.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            res.end('data: [DONE]\n\n')
          }
        } catch { /* skip malformed events */ }
      }
    }
    if (!res.writableEnded) res.end('data: [DONE]\n\n')
    recordUsage(resolved.model, 'deepseek', streamUsage.input_tokens, streamUsage.output_tokens)
    saveStats()
    return
  }

  // Non-streaming response
  const data = await upstream.json()
  recordUsage(resolved.model, 'deepseek', data.usage?.input_tokens, data.usage?.output_tokens)
  saveStats()
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
}
