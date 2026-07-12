// OpenAI API route handler
// Handles openai-api-* models via OpenAI-compatible API (uses API key)

import { proxyConfig, getRelay } from '../config.js'
import { toOpenAIApiModel } from '../models.js'
import { requestLog } from '../logger.js'
import { sendJson, readJson, fetchWithRetry, pipeResponsesUpstream, setProxyMeta } from '../server-utils.js'
import { recordUsage, saveStats } from '../stats.js'
import { responsesToChatCompletions, chatCompletionToResponse } from '../convert/chat-completions.js'
import { streamChatCompletionToResponses } from '../convert/stream.js'
import { chinaFetch, withChinaDispatcher } from '../china-fetch.js'

// Resolves which upstream actually backs the openai-api-* channel: either the
// true OpenAI API, or a configured relay standing in for it (selected via the
// admin panel's "上游" dropdown, persisted as proxyConfig.openaiApiUpstream).
export function resolveOpenAIUpstream() {
  const mode = proxyConfig.openaiApiUpstream || 'official'
  if (mode.startsWith('relay:')) {
    const relay = getRelay(mode.slice('relay:'.length))
    if (relay) {
      return {
        mode: 'relay',
        relayId: relay.id,
        relayName: relay.name,
        apiKey: relay.api_key,
        chatCompletionsUrl: relay.base_url.replace(/\/+$/, '') + '/chat/completions',
        authHeaders: { authorization: `Bearer ${relay.api_key}` }
      }
    }
  }
  const authHeaders = { authorization: `Bearer ${proxyConfig.openaiApiKey}` }
  if (proxyConfig.openaiOrgId) authHeaders['openai-organization'] = proxyConfig.openaiOrgId
  if (proxyConfig.openaiProjectId) authHeaders['openai-project'] = proxyConfig.openaiProjectId
  return {
    mode: 'official',
    apiKey: proxyConfig.openaiApiKey,
    chatCompletionsUrl: proxyConfig.openaiApiChatCompletionsUrl,
    authHeaders
  }
}

function upstreamAuthError(upstream) {
  return upstream.mode === 'relay'
    ? `中转站 "${upstream.relayName}" 未配置 API Key`
    : 'OPENAI_API_KEY is not set'
}

export async function handleOpenAIApi(req, res, body, resolved) {
  const upstream = resolveOpenAIUpstream()
  const provider = upstream.mode === 'relay' ? `relay:${upstream.relayId}` : 'openai-api'
  setProxyMeta(res, { provider, model: resolved.model })
  if (!upstream.apiKey) {
    return sendJson(res, 503, {
      error: { type: 'authentication_error', message: upstreamAuthError(upstream) }
    })
  }

  const upstreamModel = toOpenAIApiModel(resolved.model)
  const chatBody = responsesToChatCompletions(body, upstreamModel)
  const isStream = body.stream === true

  const fetchImpl = upstream.mode === 'official' ? chinaFetch(req.fetchImpl) : req.fetchImpl
  const baseOptions = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...upstream.authHeaders },
    body: JSON.stringify(chatBody),
    attemptTimeoutMs: 300000
  }
  const fetchOptions = {
    ...(upstream.mode === 'official' ? withChinaDispatcher(baseOptions) : baseOptions),
    circuitKey: provider
  }

  const upstreamResp = await fetchWithRetry(fetchImpl, upstream.chatCompletionsUrl, fetchOptions)

  requestLog(req, `model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} openai_api_model=${upstreamModel} chat_completions=1 stream=${isStream} status=${upstreamResp.status}`)

  if (!upstreamResp.ok) {
    const detail = (await upstreamResp.text().catch(() => '')).slice(0, 2000)
    return sendJson(res, upstreamResp.status, {
      error: { type: 'upstream_error', message: `OpenAI API returned HTTP ${upstreamResp.status}`, detail }
    })
  }

  if (isStream) return streamChatCompletionToResponses(upstreamResp, res, { ...body, model: resolved.model })

  const result = await upstreamResp.json()
  recordUsage(resolved.model, 'openai-api',
    result.usage?.prompt_tokens || 0,
    result.usage?.completion_tokens || 0)
  saveStats()
  return sendJson(res, 200, chatCompletionToResponse(result, { ...body, model: resolved.model }))
}

export async function handleOpenAIApiChatCompletions(req, res, body, resolved) {
  const upstream = resolveOpenAIUpstream()
  const provider = upstream.mode === 'relay' ? `relay:${upstream.relayId}` : 'openai-api'
  setProxyMeta(res, { provider, model: resolved.model })
  if (!upstream.apiKey) {
    return sendJson(res, 503, {
      error: { type: 'authentication_error', message: upstreamAuthError(upstream) }
    })
  }

  const upstreamModel = toOpenAIApiModel(resolved.model)
  const fetchImpl = upstream.mode === 'official' ? chinaFetch(req.fetchImpl) : req.fetchImpl
  const baseOptions = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...upstream.authHeaders },
    body: JSON.stringify({ ...body, model: upstreamModel }),
    attemptTimeoutMs: 300000
  }
  const fetchOptions = {
    ...(upstream.mode === 'official' ? withChinaDispatcher(baseOptions) : baseOptions),
    circuitKey: provider
  }

  const upstreamResp = await fetchWithRetry(fetchImpl, upstream.chatCompletionsUrl, fetchOptions)

  requestLog(req, `chat-completions model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} openai_api_model=${upstreamModel} status=${upstreamResp.status}`)

  return pipeResponsesUpstream(upstreamResp, res, {
    onBody: (u) => { recordUsage(resolved.model, 'openai-api', u.prompt_tokens ?? u.input_tokens, u.completion_tokens ?? u.output_tokens); saveStats() }
  })
}
