// ChatGPT Subscription route handler
// Handles gpt-* models via ChatGPT backend (uses Codex auth headers)

import { proxyConfig } from '../config.js'
import { requestLog } from '../logger.js'
import { sendJson, pipeResponsesUpstream, fetchWithRetry } from '../server-utils.js'
import { recordUsage, saveStats } from '../stats.js'
import { chinaFetch, withChinaDispatcher } from '../china-fetch.js'
import { pickActiveAccount, ensureFreshToken, markAccountCooldown } from '../chatgpt-accounts.js'

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

// Same forwarded headers as chatGptHeaders, but authorization / chatgpt-account-id
// come from the account-pool account instead of the client's own Codex session.
function buildAccountPoolHeaders(req, account, opts) {
  const headers = chatGptHeaders(req, opts)
  headers.authorization = `Bearer ${account.access_token}`
  headers['chatgpt-account-id'] = account.account_id
  return headers
}

// Sends the request using the account pool, rotating to the next account on
// a 429 and retrying the same request. Stops after cycling the whole pool so
// an all-accounts-exhausted request can't loop forever; in that case the last
// (still-429) upstream response is returned unchanged for passthrough to the client.
async function sendWithAccountRotation(req, chatGptFetch, upstreamBody, { model, tryResponsesLite }) {
  const tried = new Set()
  let account = pickActiveAccount()
  const poolSize = (proxyConfig.chatgptAccounts || []).length
  let includeResponsesLite = tryResponsesLite
  let attempts = 0
  let last = null
  let lastError = null

  while (account && attempts < poolSize) {
    attempts++
    tried.add(account.id)
    try {
      await ensureFreshToken(account, chatGptFetch)

      const options = withChinaDispatcher({
        method: 'POST',
        headers: buildAccountPoolHeaders(req, account, { includeResponsesLite }),
        body: upstreamBody,
        signal: AbortSignal.timeout(300000)
      })
      let upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, options, 2)

      if (includeResponsesLite && await isResponsesLiteUnsupported(upstream)) {
        responsesLiteUnsupportedModels.add(model)
        includeResponsesLite = false
        await upstream.body?.cancel()
        upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, {
          ...options,
          headers: buildAccountPoolHeaders(req, account, { includeResponsesLite }),
          signal: AbortSignal.timeout(300000)
        }, 2)
      }

      last = { upstream, account }
      if (upstream.status === 429) {
        requestLog(req, `chatgpt-account=${account.id} status=429 cooldown+rotate`)
        await markAccountCooldown(account.id, upstream.clone())
        account = pickActiveAccount(tried)
        continue
      }

      requestLog(req, `chatgpt-account=${account.id} status=${upstream.status}`)
      return last
    } catch (error) {
      lastError = error
      requestLog(req, `chatgpt-account=${account.id} network_error=${error.message} rotate`)
      account = pickActiveAccount(tried)
    }
  }

  if (!last && lastError) throw lastError
  return last
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
  requestLog(req, `model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} effort=${resolved.reasoningEffort || '-'}`)

  const poolAccount = pickActiveAccount()
  if (!poolAccount && (!req.headers.authorization || !req.headers['chatgpt-account-id'])) {
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
  const chatGptFetch = chinaFetch(req.fetchImpl)

  let upstream
  if (poolAccount) {
    const result = await sendWithAccountRotation(req, chatGptFetch, upstreamBody, { model: resolved.model, tryResponsesLite })
    upstream = result.upstream
  } else {
    const upstreamOptions = withChinaDispatcher({
      method: 'POST',
      headers: chatGptHeaders(req, { includeResponsesLite: tryResponsesLite }),
      body: upstreamBody,
      signal: AbortSignal.timeout(300000)
    })

    upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, upstreamOptions)

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
  }

  return pipeResponsesUpstream(upstream, res, {
    onBody: (u) => { recordUsage(resolved.model, 'chatgpt-sub', u.input_tokens, u.output_tokens); saveStats() }
  })
}

// Used by /v1/chat/completions fallback for subscription models
export async function handleChatGptSubChatCompletions(req, res, body, resolved) {
  requestLog(req, `chat-completions model=${resolved.model} body_model=${resolved.bodyModel || '-'} thread=${resolved.threadId || '-'} effort=${resolved.reasoningEffort || '-'}`)

  const poolAccount = pickActiveAccount()
  if (!poolAccount && (!req.headers.authorization || !req.headers['chatgpt-account-id'])) {
    return sendJson(res, 401, {
      error: { type: 'authentication_error', message: 'ChatGPT subscription headers were not provided by Codex' }
    })
  }

  const upstreamBody = JSON.stringify({ ...body, model: resolved.model })
  const chatGptFetch = chinaFetch(req.fetchImpl)

  let upstream
  if (poolAccount) {
    const result = await sendWithAccountRotation(req, chatGptFetch, upstreamBody, { model: resolved.model, tryResponsesLite: false })
    upstream = result.upstream
  } else {
    const upstreamOptions = withChinaDispatcher({
      method: 'POST',
      headers: chatGptHeaders(req, { includeResponsesLite: false }),
      body: upstreamBody,
      signal: AbortSignal.timeout(300000)
    })
    upstream = await fetchWithRetry(chatGptFetch, proxyConfig.chatgptResponsesUrl, upstreamOptions)
  }

  return pipeResponsesUpstream(upstream, res, {
    onBody: (u) => { recordUsage(resolved.model, 'chatgpt-sub', u.input_tokens, u.output_tokens); saveStats() }
  })
}
