// ChatGPT Subscription route handler
// Handles gpt-* models via ChatGPT backend (uses Codex auth headers)

import { proxyConfig } from '../config.js'
import { requestLog } from '../logger.js'
import { sendJson, pipeResponsesUpstream, fetchWithRetry } from '../server-utils.js'
import { recordUsage, saveStats } from '../stats.js'
import { chinaFetch, withChinaDispatcher } from '../china-fetch.js'

const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'
const responsesLiteUnsupportedModels = new Set()

function chatGptHeaders(req, { includeResponsesLite = true } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
  const forwarded = [
    'authorization', 'chatgpt-account-id', 'originator', 'session-id',
    'thread-id', 'user-agent', 'x-client-request-id', 'x-codex-beta-features',
    'x-codex-turn-metadata', 'x-codex-window-id'
  ]
  if (includeResponsesLite) forwarded.push(RESPONSES_LITE_HEADER)
  for (const name of forwarded) {
    const value = req.headers[name]
    if (value) headers[name] = value
  }
  return headers
}

async function isResponsesLiteUnsupported(response) {
  if (response.status !== 400) return false
  let text
  try { text = await response.clone().text() } catch { return false }
  if (!/responses-lite|x-openai-internal-codex-responses-lite/i.test(text)) return false
  try {
    const payload = JSON.parse(text)
    const error = payload?.error || payload
    return error?.code === 'unsupported_value' || /not supported|unsupported/i.test(error?.message || '')
  } catch {
    return /not supported|unsupported_value/i.test(text)
  }
}

export async function handleChatGptSub(req, res, body, resolved) {
  if (!req.headers.authorization || !req.headers['chatgpt-account-id']) {
    return sendJson(res, 401, {
      error: { type: 'authentication_error', message: 'ChatGPT subscription headers were not provided by Codex' }
    })
  }

  const upstreamBody = JSON.stringify({
    ...body,
    model: resolved.model,
    ...(resolved.reasoningEffort ? { reasoning: { ...(body.reasoning || {}), effort: resolved.reasoningEffort } } : {})
  })

  const requestedResponsesLite = Boolean(req.headers[RESPONSES_LITE_HEADER])
  const tryResponsesLite = requestedResponsesLite && !responsesLiteUnsupportedModels.has(resolved.model)

  const upstreamOptions = withChinaDispatcher({
    method: 'POST',
    headers: chatGptHeaders(req, { includeResponsesLite: tryResponsesLite }),
    body: upstreamBody,
    signal: AbortSignal.timeout(300000)
  })

  const chatGptFetch = chinaFetch(req.fetchImpl)
  let upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, upstreamOptions)

  if (tryResponsesLite && await isResponsesLiteUnsupported(upstream)) {
    responsesLiteUnsupportedModels.add(resolved.model)
    requestLog(req, `model=${resolved.model} responses_lite=unsupported retry=standard`)
    await upstream.body?.cancel()
    upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, {
      ...upstreamOptions,
      headers: chatGptHeaders(req, { includeResponsesLite: false }),
      signal: AbortSignal.timeout(300000)
    })
  }

  return pipeResponsesUpstream(upstream, res, {
    onBody: (u) => { recordUsage(resolved.model, 'chatgpt-sub', u.input_tokens, u.output_tokens); saveStats() }
  })
}

// Used by /v1/chat/completions fallback for subscription models
export async function handleChatGptSubChatCompletions(req, res, body, resolved) {
  if (!req.headers.authorization || !req.headers['chatgpt-account-id']) {
    return sendJson(res, 401, {
      error: { type: 'authentication_error', message: 'ChatGPT subscription headers were not provided by Codex' }
    })
  }

  const upstreamOptions = withChinaDispatcher({
    method: 'POST',
    headers: chatGptHeaders(req, { includeResponsesLite: false }),
    body: JSON.stringify({ ...body, model: resolved.model }),
    signal: AbortSignal.timeout(300000)
  })

  const chatGptFetch = chinaFetch(req.fetchImpl)
  const upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, upstreamOptions)
  return pipeResponsesUpstream(upstream, res, {
    onBody: (u) => { recordUsage(resolved.model, 'chatgpt-sub', u.input_tokens, u.output_tokens); saveStats() }
  })
}
