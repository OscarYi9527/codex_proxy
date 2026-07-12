// Main HTTP server - request routing hub
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import { PROXY_DIR, proxyConfig } from './config.js'
import { requestLog } from './logger.js'
import { sendJson, readJson, id, setProxyMeta } from './server-utils.js'
import { getCircuitStates, resetCircuits } from './circuit-breaker.js'
import { resolveCodexModel, buildModelsResponse, isChatGptSubModel, isOpenAIApiModel, isRelayModel, shouldRouteViaOpenAIApi } from './models.js'
import { handleThreadRouteReq } from './routes/thread-route.js'
import { handleChatGptSub, handleChatGptSubChatCompletions } from './routes/chatgpt-sub.js'
import { handleOpenAIApi, handleOpenAIApiChatCompletions } from './routes/openai-api.js'
import { handleDeepSeek, handleDeepSeekChatCompletions } from './routes/deepseek.js'
import { handleRelay, handleRelayChatCompletions } from './routes/relay.js'
import { handlePing, handlePingAll } from './routes/ping.js'
import { saveStats } from './stats.js'
import { getAdminHtml, getAdminAppJs, isLocalAdminRequest, handleAdminConfigGet, handleAdminConfigPut, handleStatsGet, handleStatsDelete, handleRelayAdd, handleRelayDelete, handleChatgptAccountAdd, handleChatgptAccountImportCurrent, handleChatgptAccountDelete, handleChatgptAccountsReorder, handleChatgptAccountRouting, handleChatgptLoginStart, handleChatgptLoginStatus, handleChatgptLoginCancel, handleChatgptAccountRefreshUsage, handleChatgptAccountsRefreshAll, handleChatgptAccountSwitch, handleCodexRestart, handleDiagnosticsGet, handleConfigSnapshotsGet, handleConfigRollback, handleRuntimeRepair, handleProxyRestart } from './admin.js'

const PORT = Number(process.env.CODEX_PROXY_PORT || 47892)
const HOST = process.env.CODEX_PROXY_HOST || '127.0.0.1'
const INSTANCE_FILE = path.join(os.homedir(), '.codex-proxy-instance.json')

const BASE_INSTRUCTIONS = 'You are Codex, a coding agent. Use the provided tools to inspect, edit, and verify the user\u0027s workspace. Preserve unrelated changes and report completed work concisely.'

function processIsAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function acquireInstanceLock() {
  const payload = JSON.stringify({
    pid: process.pid,
    script: fileURLToPath(import.meta.url),
    started_at: new Date().toISOString()
  }, null, 2)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(INSTANCE_FILE, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const existing = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'))
        if (processIsAlive(existing.pid)) {
          throw new Error(`Another Codex proxy instance is already running (PID ${existing.pid}, ${existing.script || 'unknown path'})`)
        }
      } catch (readError) {
        if (/already running/.test(readError.message)) throw readError
      }
      fs.rmSync(INSTANCE_FILE, { force: true })
    }
  }
  throw new Error('Could not acquire Codex proxy instance lock')
}

function releaseInstanceLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'))
    if (Number(existing.pid) === process.pid) fs.rmSync(INSTANCE_FILE, { force: true })
  } catch {}
}

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
    req.requestId = id('req')
    setProxyMeta(res, { requestId: req.requestId, startedAt: Date.now() })
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (!(req.method === 'GET' && ['/health', '/live', '/ready'].includes(url.pathname))) {
      requestLog(req)
    }

    // Liveness only means the local process can serve requests. Readiness
    // means at least one usable upstream has been configured.
    if (req.method === 'GET' && url.pathname === '/live') {
      return sendJson(res, 200, { status: 'ok', port: PORT })
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
      const relays = proxyConfig.relays || []
      const chatgptReady = (proxyConfig.chatgptAccounts || []).some(account =>
        account.routing_enabled !== false &&
        Boolean(account.access_token || account.refresh_token)
      )
      const ready = Boolean(
        proxyConfig.deepseekApiKey ||
        proxyConfig.openaiApiKey ||
        relays.some(r => r.api_key) ||
        chatgptReady
      )
      return sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ok' : 'unavailable',
        provider: 'deepseek',
        providers: {
          deepseek: Boolean(proxyConfig.deepseekApiKey),
          'openai-api': Boolean(proxyConfig.openaiApiKey),
          'chatgpt-sub': chatgptReady,
          relays: relays.map(r => r.id)
        },
        circuits: getCircuitStates(),
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
        setProxyMeta(res, { model: resolved.model })
        requestLog(req, 'model=' + resolved.model + ' effort=' + (resolved.reasoningEffort || 'default') + ' stream=' + body.stream)

        if (isRelayModel(resolved.model)) return await handleRelay(req, res, body, resolved)
        if (shouldRouteViaOpenAIApi(resolved.model)) return await handleOpenAIApi(req, res, body, resolved)
        if (isChatGptSubModel(resolved.model)) return await handleChatGptSub(req, res, body, resolved)
        return await handleDeepSeek(req, res, body, resolved)
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
        setProxyMeta(res, { model: resolved.model })
        requestLog(req, 'chat-completions model=' + resolved.model + ' stream=' + body.stream)

        if (isRelayModel(resolved.model)) return await handleRelayChatCompletions(req, res, body, resolved)
        if (shouldRouteViaOpenAIApi(resolved.model)) return await handleOpenAIApiChatCompletions(req, res, body, resolved)
        if (isChatGptSubModel(resolved.model)) return await handleChatGptSubChatCompletions(req, res, body, resolved)
        return await handleDeepSeekChatCompletions(req, res, body, resolved)
      } catch (error) {
        console.error('[codex-proxy] chat/completions failed:', error.message)
        if (!res.headersSent) return sendJson(res, 502, { error: { type: 'proxy_error', message: error.message } })
        if (!res.writableEnded) res.end()
      }
      return
    }

    // Every admin mutation is local-only and validates Host/Origin centrally.
    if (
      url.pathname.startsWith('/admin/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !isLocalAdminRequest(req)
    ) {
      return sendJson(res, 403, {
        error: { type: 'permission_error', message: 'Admin changes are only allowed from the local console' }
      })
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

    // ChatGPT account pool CRUD
    if (req.method === 'POST' && url.pathname === '/admin/api/chatgpt-accounts') {
      const body = await readJson(req)
      return handleChatgptAccountAdd(req, res, body)
    }
    if (req.method === 'POST' && url.pathname === '/admin/api/chatgpt-accounts/import-current') {
      return handleChatgptAccountImportCurrent(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/admin/api/chatgpt-login/start') {
      return handleChatgptLoginStart(req, res)
    }
    if (req.method === 'GET' && url.pathname === '/admin/api/chatgpt-login/status') {
      return handleChatgptLoginStatus(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/admin/api/chatgpt-login/cancel') {
      return handleChatgptLoginCancel(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/admin/api/chatgpt-accounts/refresh-usage-all') {
      return handleChatgptAccountsRefreshAll(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/admin/api/chatgpt-accounts/reorder') {
      const body = await readJson(req)
      return handleChatgptAccountsReorder(req, res, body)
    }
    const refreshUsageMatch = url.pathname.match(/^\/admin\/api\/chatgpt-accounts\/([^/]+)\/refresh-usage$/)
    if (req.method === 'POST' && refreshUsageMatch) {
      return handleChatgptAccountRefreshUsage(req, res, decodeURIComponent(refreshUsageMatch[1]))
    }
    const switchMatch = url.pathname.match(/^\/admin\/api\/chatgpt-accounts\/([^/]+)\/switch$/)
    if (req.method === 'POST' && switchMatch) {
      return handleChatgptAccountSwitch(req, res, decodeURIComponent(switchMatch[1]))
    }
    if (req.method === 'POST' && url.pathname === '/admin/api/codex/restart') {
      return handleCodexRestart(req, res)
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/chatgpt-accounts/')) {
      return handleChatgptAccountDelete(req, res, decodeURIComponent(url.pathname.split('/').pop()))
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/stats') return handleStatsGet(req, res)
    if (req.method === 'DELETE' && url.pathname === '/admin/api/stats') return handleStatsDelete(req, res)
    if (req.method === 'GET' && url.pathname === '/admin/api/diagnostics') return handleDiagnosticsGet(req, res)
    if (req.method === 'GET' && url.pathname === '/admin/api/config-snapshots') return handleConfigSnapshotsGet(req, res)
    if (req.method === 'POST' && url.pathname === '/admin/api/config-rollback') return handleConfigRollback(req, res)
    if (req.method === 'POST' && url.pathname === '/admin/api/runtime-repair') return handleRuntimeRepair(req, res)
    if (req.method === 'POST' && url.pathname === '/admin/api/proxy/restart') return handleProxyRestart(req, res)
    if (req.method === 'GET' && url.pathname === '/admin/api/resilience') {
      return sendJson(res, 200, { circuits: getCircuitStates() })
    }
    const accountRoutingMatch = url.pathname.match(/^\/admin\/api\/chatgpt-accounts\/([^/]+)\/routing$/)
    if (req.method === 'POST' && accountRoutingMatch) {
      const body = await readJson(req)
      return handleChatgptAccountRouting(req, res, decodeURIComponent(accountRoutingMatch[1]), body)
    }
    if (req.method === 'DELETE' && url.pathname === '/admin/api/resilience') {
      resetCircuits()
      return sendJson(res, 200, { circuits: [] })
    }

    // 404
    requestLog(req, 'REJECTED-404')
    return sendJson(res, 404, { error: { type: 'invalid_request_error', message: 'Not found: ' + req.method + ' ' + url.pathname } })
  })
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false
if (isMain) {
  acquireInstanceLock()
  const server = createServer()
  let shuttingDown = false
  const gracefulShutdown = signal => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[codex-proxy] ${signal} received; draining active requests`)
    releaseInstanceLock()
    saveStats()
    server.close(error => {
      if (error) console.error('[codex-proxy] graceful shutdown error:', error.message)
      process.exit(error ? 1 : 0)
    })
    setTimeout(() => {
      console.error('[codex-proxy] graceful shutdown timeout; forcing remaining connections closed')
      server.closeAllConnections?.()
      process.exit(1)
    }, 310_000).unref()
  }
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.once('SIGINT', () => gracefulShutdown('SIGINT'))
  process.once('exit', releaseInstanceLock)
  server.listen(PORT, HOST, () => {
    console.log('[codex-proxy] listening on http://' + HOST + ':' + PORT)
    console.log('[codex-proxy] channels: gpt-* | openai-api-* | relay-* | * -> DeepSeek')
  })
}
