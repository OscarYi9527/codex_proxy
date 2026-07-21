import { proxyConfig } from '../config.js'
import { safeErrorText } from '../logger.js'
import { sendJson } from '../server-utils.js'
import { chinaFetch, withChinaDispatcher } from '../china-fetch.js'
import { resolveOpenAIUpstream } from './openai-api.js'
import { recordProviderOutcome } from '../provider-health.js'

// DeepSeek 连通性检查
async function pingDeepSeek(fetchImpl) {
  const start = Date.now()
  if (!proxyConfig.deepseekApiKey) {
    return { ok: false, error: 'DeepSeek API Key 未配置', latency: 0 }
  }
  try {
    const r = await fetchImpl(proxyConfig.upstreamUrl, {
      method: 'OPTIONS',
      headers: { 'x-api-key': proxyConfig.deepseekApiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(5000)
    })
    return { ok: r.ok || r.status < 500, status: r.status, latency: Date.now() - start }
  } catch (e) {
    return { ok: false, error: safeErrorText(e), latency: Date.now() - start }
  }
}

// OpenAI API 连通性检查 (按当前生效的上游: 官方 或 选定的中转站)
async function pingOpenAIApi(fetchImpl) {
  const start = Date.now()
  const upstream = resolveOpenAIUpstream()
  if (!upstream.apiKey) {
    return { ok: false, error: upstream.mode === 'relay' ? `中转站 "${upstream.relayName}" 未配置 API Key` : 'OpenAI API Key 未配置', latency: 0 }
  }
  try {
    const modelsUrl = upstream.chatCompletionsUrl.replace(/\/chat\/completions$/, '/models')
    const probeFetch = upstream.mode === 'official' ? chinaFetch(fetchImpl) : fetchImpl
    const baseOptions = { method: 'GET', headers: upstream.authHeaders, signal: AbortSignal.timeout(5000) }
    const options = upstream.mode === 'official' ? withChinaDispatcher(baseOptions) : baseOptions
    const r = await probeFetch(modelsUrl, options)
    return { ok: r.ok, status: r.status, latency: Date.now() - start, note: upstream.mode === 'relay' ? `经中转站: ${upstream.relayName}` : '' }
  } catch (e) {
    return { ok: false, error: safeErrorText(e), latency: Date.now() - start }
  }
}

// ChatGPT 订阅连通性检查
async function pingChatGptSub(fetchImpl) {
  const start = Date.now()
  const chatGptFetch = chinaFetch(fetchImpl)
  try {
    const r = await chatGptFetch(proxyConfig.chatgptResponsesUrl, withChinaDispatcher({
      method: 'OPTIONS', signal: AbortSignal.timeout(5000)
    }))
    const ok = r.ok || r.status === 401 || r.status === 405
    return { ok, status: r.status, latency: Date.now() - start, note: (r.status === 401 || r.status === 405) ? '可访问 (需认证)' : '' }
  } catch (e) {
    return { ok: false, error: safeErrorText(e), latency: Date.now() - start }
  }
}

// 中转站连通性检查
async function pingRelay(fetchImpl, relayId) {
  const start = Date.now()
  const relay = (proxyConfig.relays || []).find(r => r.id === relayId)
  if (!relay) return { ok: false, error: '中转站不存在', latency: 0 }
  if (!relay.api_key) return { ok: false, error: '中转站 API Key 未配置', latency: 0 }
  try {
    const base = relay.base_url.replace(/\/+$/, '')
    const r = await fetchImpl(base + '/models', {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + relay.api_key },
      signal: AbortSignal.timeout(5000)
    })
    return { ok: r.ok, status: r.status, latency: Date.now() - start }
  } catch (e) {
    return { ok: false, error: safeErrorText(e), latency: Date.now() - start }
  }
}

// 模型级连通性 (发送一个最小 Chat Completions 请求)
async function pingModel(fetchImpl, model) {
  const start = Date.now()

  // relay-* 模型
  if (model.startsWith('relay-')) {
    const parts = model.split('-')
    if (parts.length < 3) return { ok: false, error: '无效中站模型格式', latency: 0 }
    const relayId = parts[1]
    const upstreamModel = parts.slice(2).join('-')
    const relay = (proxyConfig.relays || []).find(r => r.id === relayId)
    if (!relay) return { ok: false, error: '中转站不存在', latency: 0 }
    if (!relay.api_key) return { ok: false, error: '中转站 API Key 未配置', latency: 0 }
    try {
      const base = relay.base_url.replace(/\/+$/, '')
      const r = await fetchImpl(base + '/chat/completions', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + relay.api_key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: upstreamModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(5000)
      })
      return { ok: r.ok, status: r.status, latency: Date.now() - start }
    } catch (e) {
      return { ok: false, error: safeErrorText(e), latency: Date.now() - start }
    }
  }

  // openai-api-* 模型 (按当前生效的上游: 官方 或 选定的中转站)
  if (model.startsWith('openai-api-')) {
    const upstream = resolveOpenAIUpstream()
    if (!upstream.apiKey) return { ok: false, error: upstream.mode === 'relay' ? `中转站 "${upstream.relayName}" 未配置 API Key` : 'OpenAI API Key 未配置', latency: 0 }
    const upstreamModel = model.replace('openai-api-', '').replace(/-compact$/, '')
    try {
      const probeFetch = upstream.mode === 'official' ? chinaFetch(fetchImpl) : fetchImpl
      const baseOptions = {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...upstream.authHeaders },
        body: JSON.stringify({ model: upstreamModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(5000)
      }
      const options = upstream.mode === 'official' ? withChinaDispatcher(baseOptions) : baseOptions
      const r = await probeFetch(upstream.chatCompletionsUrl, options)
      return { ok: r.ok, status: r.status, latency: Date.now() - start }
    } catch (e) {
      return { ok: false, error: safeErrorText(e), latency: Date.now() - start }
    }
  }

  return { ok: false, error: '该模型类型不支持 ping', latency: 0 }
}

// ── API 入口 ──────────────────────────────────────────────

export async function handlePing(req, res, body) {
  const { type, relayId, model: pingModelId } = body || {}

  if (pingModelId) {
    const result = await pingModel(req.fetchImpl, pingModelId)
    const provider = pingModelId.startsWith('relay-')
      ? `relay:${pingModelId.split('-')[1]}`
      : (pingModelId.startsWith('openai-api-') ? 'openai-api' : null)
    recordProviderOutcome(provider, {
      status: result.status,
      latencyMs: result.latency,
      error: result.ok ? null : result.error || `HTTP ${result.status || 0}`,
      source: 'manual_ping'
    })
    return sendJson(res, result.ok ? 200 : 502, { ping: pingModelId, ...result })
  }

  if (type === 'relay') {
    if (!relayId) return sendJson(res, 400, { error: 'relayId 必填' })
    const result = await pingRelay(req.fetchImpl, relayId)
    recordProviderOutcome(`relay:${relayId}`, {
      status: result.status,
      latencyMs: result.latency,
      error: result.ok ? null : result.error || `HTTP ${result.status || 0}`,
      source: 'manual_ping'
    })
    return sendJson(res, result.ok ? 200 : 502, { ping: '中转站:' + relayId, ...result })
  }

  const pings = { 'deepseek': pingDeepSeek, 'openai-api': pingOpenAIApi, 'chatgpt-sub': pingChatGptSub }
  const fn = pings[type]
  if (!fn) return sendJson(res, 400, { error: '未知类型: ' + type + ', 可选: deepseek, openai-api, chatgpt-sub, relay, model' })

  const result = await fn(req.fetchImpl)
  recordProviderOutcome(type, {
    status: result.status,
    latencyMs: result.latency,
    error: result.ok ? null : result.error || `HTTP ${result.status || 0}`,
    source: 'manual_ping'
  })
  const names = { 'deepseek': 'DeepSeek', 'openai-api': 'OpenAI API', 'chatgpt-sub': 'ChatGPT 订阅' }
  return sendJson(res, result.ok ? 200 : 502, { ping: names[type] || type, ...result })
}

// 全通道一键测试
export async function handlePingAll(req, res) {
  const results = {
    'deepseek': await pingDeepSeek(req.fetchImpl),
    'openai-api': await pingOpenAIApi(req.fetchImpl),
    'chatgpt-sub': await pingChatGptSub(req.fetchImpl)
  }
  for (const relay of (proxyConfig.relays || [])) {
    results['relay:' + relay.id] = await pingRelay(req.fetchImpl, relay.id)
  }
  for (const [provider, result] of Object.entries(results)) {
    recordProviderOutcome(provider, {
      status: result.status,
      latencyMs: result.latency,
      error: result.ok ? null : result.error || `HTTP ${result.status || 0}`,
      source: 'manual_ping'
    })
  }
  const allOk = Object.values(results).every(r => r.ok)
  return sendJson(res, allOk ? 200 : 502, { results, allOk })
}
