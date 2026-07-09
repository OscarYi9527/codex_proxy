// Main HTTP server - request routing hub
import http from 'http'
import fs from 'fs'
import path from 'path'

import { PROXY_DIR, proxyConfig } from './config.js'
import { requestLog } from './logger.js'
import { sendJson, readJson } from './server-utils.js'
import { resolveCodexModel, buildModelsResponse, isChatGptSubModel, isOpenAIApiModel, isRelayModel, shouldRouteViaOpenAIApi } from './models.js'
import { handleThreadRouteReq } from './routes/thread-route.js'
import { handleChatGptSub, handleChatGptSubChatCompletions } from './routes/chatgpt-sub.js'
import { handleOpenAIApi, handleOpenAIApiChatCompletions } from './routes/openai-api.js'
import { handleDeepSeek, handleDeepSeekChatCompletions } from './routes/deepseek.js'
import { handleRelay, handleRelayChatCompletions } from './routes/relay.js'
import { handlePing, handlePingAll } from './routes/ping.js'
import { getAdminHtml, getAdminAppJs, handleAdminConfigGet, handleAdminConfigPut, handleStatsGet, handleStatsDelete, handleRelayAdd, handleRelayDelete } from './admin.js'

const PORT = Number(process.env.CODEX_PROXY_PORT || 47892)
const HOST = process.env.CODEX_PROXY_HOST || '127.0.0.1'

const BASE_INSTRUCTIONS = 'You are Codex, a coding agent. Use the provided tools to inspect, edit, and verify the user\u0027s workspace. Preserve unrelated changes and report completed work concisely.'

function makeRelayModel(slug, display, desc) {
  return {
    slug, display_name: display, description: desc,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast' },
      { effort: 'medium', description: 'Balanced' },
      { effort: 'high', description: 'Deep reasoning' },
      { effort: 'xhigh', description: 'Max reasoning' }
    ],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 10,
    supports_reasoning_summaries: true, default_reasoning_summary: 'none',
    support_verbosity: true, default_verbosity: 'low',
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true, supports_image_detail_original: true,
    supports_search_tool: true, use_responses_lite: false,
    experimental_supported_tools: [], context_window: 372000,
    effective_context_window_percent: 95,
    input_modalities: ['text', 'image'],
    base_instructions: BASE_INSTRUCTIONS
  }
}

export function createServer({ fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    req.fetchImpl = fetchImpl
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (!(req.method === 'GET' && url.pathname === '/health')) {
      requestLog(req)
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      const relays = proxyConfig.relays || []
      const ready = Boolean(proxyConfig.deepseekApiKey || proxyConfig.openaiApiKey || relays.some(r => r.api_key))
      return sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ok' : 'unavailable',
        provider: 'deepseek',
        providers: {
          deepseek: Boolean(proxyConfig.deepseekApiKey),
          'openai-api': Boolean(proxyConfig.openaiApiKey),
          'chatgpt-sub': true,
          relays: relays.map(r => r.id)
        },
        port: PORT
      })
    }

    // Base connectivity
    if (req.method === 'HEAD' && (url.pathname === '/v1' || url.pathname === '/v1/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end()
    }

    // Thread route control
    if (/^\/control\/threads\/[^/]+\/route$/.test(url.pathname)) {
      return handleThreadRouteReq(req, res, url)
    }

    // Models list (with dynamic relay injection)
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      let localModels = []
      try {
        localModels = JSON.parse(fs.readFileSync(path.join(PROXY_DIR, '..', 'codex-models.json'), 'utf8')).models || []
      } catch {}

      const relayModels = []
      for (const relay of (proxyConfig.relays || [])) {
        for (const m of (relay.models || ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'])) {
          const slug = 'relay-' + relay.id + '-' + m
          relayModels.push(makeRelayModel(slug, m.toUpperCase() + ' (' + relay.name + ')', relay.name + ' - ' + relay.base_url))
        }
      }
      localModels = [...relayModels, ...localModels]

      return sendJson(res, 200, buildModelsResponse(localModels))
    }

    // POST /v1/responses
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname.endsWith('/responses'))) {
      try {
        const body = await readJson(req)
        const resolved = resolveCodexModel(body)
        requestLog(req, 'model=' + resolved.model + ' effort=' + (resolved.reasoningEffort || 'default') + ' stream=' + body.stream)

        if (isRelayModel(resolved.model)) return handleRelay(req, res, body, resolved)
        if (shouldRouteViaOpenAIApi(resolved.model)) return handleOpenAIApi(req, res, body, resolved)
        if (isChatGptSubModel(resolved.model)) return handleChatGptSub(req, res, body, resolved)
        return handleDeepSeek(req, res, body, resolved)
      } catch (error) {
        console.error('[codex-proxy] request failed:', error.message)
        if (!res.headersSent) return sendJson(res, 502, { error: { type: 'proxy_error', message: error.message } })
        if (!res.writableEnded) res.end()
      }
      return
    }

    // GET /v1/responses/:id
    const respMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/)
    if (req.method === 'GET' && respMatch) {
      return sendJson(res, 501, { error: { type: 'not_implemented', message: 'Not supported' } })
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      try {
        const body = await readJson(req)
        const resolved = resolveCodexModel(body)
        requestLog(req, 'chat-completions model=' + resolved.model + ' stream=' + body.stream)

        if (isRelayModel(resolved.model)) return handleRelayChatCompletions(req, res, body, resolved)
        if (shouldRouteViaOpenAIApi(resolved.model)) return handleOpenAIApiChatCompletions(req, res, body, resolved)
        if (isChatGptSubModel(resolved.model)) return handleChatGptSubChatCompletions(req, res, body, resolved)
        return handleDeepSeekChatCompletions(req, res, body, resolved)
      } catch (error) {
        console.error('[codex-proxy] chat/completions failed:', error.message)
        if (!res.headersSent) return sendJson(res, 502, { error: { type: 'proxy_error', message: error.message } })
        if (!res.writableEnded) res.end()
      }
      return
    }

    // ?? Connectivity ping ????????????????????????????????????
    if (req.method === 'POST' && url.pathname === '/admin/api/ping') {
      const body = await readJson(req)
      return handlePing(req, res, body)
    }

    if (req.method === 'POST' && url.pathname === '/admin/api/ping-all') {
      return handlePingAll(req, res)
    }

    // Admin panel
    if (req.method === 'GET' && url.pathname === '/admin/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(getAdminAppJs())
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(getAdminHtml())
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/config') return handleAdminConfigGet(req, res)
    if (req.method === 'PUT' && url.pathname === '/admin/api/config') return handleAdminConfigPut(req, res)

    // Relay CRUD
    if (req.method === 'POST' && url.pathname === '/admin/api/relays') {
      const body = await readJson(req)
      return handleRelayAdd(req, res, body)
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/relays/')) {
      return handleRelayDelete(req, res, decodeURIComponent(url.pathname.split('/').pop()))
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/stats') return handleStatsGet(req, res)
    if (req.method === 'DELETE' && url.pathname === '/admin/api/stats') return handleStatsDelete(req, res)

    // 404
    requestLog(req, 'REJECTED-404')
    return sendJson(res, 404, { error: { type: 'invalid_request_error', message: 'Not found: ' + req.method + ' ' + url.pathname } })
  })
}

const isMain = import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') || '')
if (isMain || process.argv[1]?.includes('codex-proxy')) {
  const server = createServer()
  server.listen(PORT, HOST, () => {
    console.log('[codex-proxy] listening on http://' + HOST + ':' + PORT)
    console.log('[codex-proxy] channels: gpt-* | openai-api-* | relay-* | * -> DeepSeek')
  })
}