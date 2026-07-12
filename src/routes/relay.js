// GPT 中转站路由 - 处理 relay-{id}-{model} 格式的模型
// 每个中转站是独立的 OpenAI 兼容端点

import { parseRelayModel } from '../models.js'
import { requestLog } from '../logger.js'
import { sendJson, fetchWithRetry, setProxyMeta, proxyMetaHeaders } from '../server-utils.js'
import { recordUsage, saveStats } from '../stats.js'
import { responsesToChatCompletions, chatCompletionToResponse } from '../convert/chat-completions.js'
import { streamChatCompletionToResponses } from '../convert/stream.js'

export async function handleRelay(req, res, body, resolved) {
  const parsed = parseRelayModel(resolved.model)
  if (!parsed) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: `无法解析中转站模型: ${resolved.model}` } })
  }

  const { relay, upstreamModel } = parsed
  setProxyMeta(res, { provider: `relay:${relay.id}`, model: resolved.model })

  if (!relay.api_key) {
    return sendJson(res, 503, { error: { type: 'authentication_error', message: `中转站 "${relay.name}" 未配置 API Key` } })
  }

  const chatBody = responsesToChatCompletions(body, upstreamModel)
  const isStream = body.stream === true
  const baseUrl = relay.base_url.replace(/\/+$/, '')
  const url = baseUrl + '/chat/completions'

  requestLog(req, `relay=${relay.id}(${relay.name}) model=${upstreamModel} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} stream=${isStream} url=${baseUrl}`)

  const upstream = await fetchWithRetry(req.fetchImpl, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${relay.api_key}`
    },
    body: JSON.stringify(chatBody),
    signal: req.clientAbortSignal,
    attemptTimeoutMs: 300000,
    circuitKey: `relay:${relay.id}`
  })

  requestLog(req, `relay=${relay.id} status=${upstream.status}`)

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 2000)
    return sendJson(res, upstream.status, {
      error: { type: 'upstream_error', message: `中转站 "${relay.name}" 返回 HTTP ${upstream.status}`, detail }
    })
  }

  if (isStream) {
    return streamChatCompletionToResponses(upstream, res, { ...body, model: resolved.model })
  }

  const result = await upstream.json()
  recordUsage(resolved.model, `relay:${relay.id}`,
    result.usage?.prompt_tokens || 0,
    result.usage?.completion_tokens || 0)
  saveStats()
  return sendJson(res, 200, chatCompletionToResponse(result, { ...body, model: resolved.model }))
}

export async function handleRelayChatCompletions(req, res, body, resolved) {
  const parsed = parseRelayModel(resolved.model)
  if (!parsed) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: `无法解析中转站模型: ${resolved.model}` } })
  }

  const { relay, upstreamModel } = parsed
  setProxyMeta(res, { provider: `relay:${relay.id}`, model: resolved.model })

  if (!relay.api_key) {
    return sendJson(res, 503, { error: { type: 'authentication_error', message: `中转站 "${relay.name}" 未配置 API Key` } })
  }

  const baseUrl = relay.base_url.replace(/\/+$/, '')
  const url = baseUrl + '/chat/completions'

  requestLog(req, `relay=${relay.id}(${relay.name}) chat-completions model=${upstreamModel} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} url=${baseUrl}`)

  const upstream = await fetchWithRetry(req.fetchImpl, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${relay.api_key}`
    },
    body: JSON.stringify({ ...body, model: upstreamModel }),
    signal: req.clientAbortSignal,
    attemptTimeoutMs: 300000,
    circuitKey: `relay:${relay.id}`
  })

  requestLog(req, `relay=${relay.id} chat-completions status=${upstream.status}`)

  // pipe through
  const headers = {}
  for (const name of ['content-type', 'cache-control', 'x-request-id']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  Object.assign(headers, proxyMetaHeaders(res))
  res.writeHead(upstream.status, headers)
  let bodyText = ''
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      const buf = Buffer.from(chunk)
      bodyText += buf.toString('utf8')
      res.write(buf)
    }
  }
  res.end()

  // Record usage if possible
  if (bodyText) {
    try {
      const data = JSON.parse(bodyText)
      if (data.usage) {
        recordUsage(resolved.model, `relay:${relay.id}`,
          data.usage.prompt_tokens || 0,
          data.usage.completion_tokens || 0)
        saveStats()
      }
    } catch {}
  }
}
