import { describe, it } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCodexModel, isChatGptSubModel, isOpenAIApiModel, isRelayModel, parseRelayModel, buildModelsResponse, getThreadId } from '../src/models.js'
import { recordUsage, recordAccountOutcome, recordOperationalEvent, getStats, resetStats, saveStats, statsDayKey } from '../src/stats.js'
import { ACCOUNT_ROUTING_STRATEGIES, accountActiveRequestCount, accountConcurrencyLimit, accountPolicyState, accountRemainingPercent, accountUsageIsFresh, calculateUsageForecast, consumeAccountResetCredit, cooldownMsFromResponseText, ensureFreshToken, extractResetCredits, extractUsageFromBody, extractUsageFromHeaders, mergeAccountUsageWindows, normalizeAccountRoutingStrategy, noteAccountAdaptiveOutcome, noteAccountSuccess, pickActiveAccount, refreshAccountResetCredits, refreshAccountUsage, releaseAccountRequest, renewAccountRequestLease, reserveAccountRequest, resetAccountRequestCounts, resetAccountStickiness } from '../src/chatgpt-accounts.js'
import { proxyConfig, atomicWriteJson, configForSettingsSnapshot, mergeAccountBackup, mergeSettingsSnapshot, orderChatgptAccounts, renameChatgptAccountInList } from '../src/config.js'
import { assertCircuitAvailable, getCircuitStates, recordCircuitResult, resetCircuits } from '../src/circuit-breaker.js'
import { fetchWithRetry, proxyMetaHeaders, retryAfterMs } from '../src/server-utils.js'
import { redactSecrets } from '../src/logger.js'
import { createServer } from '../src/server.js'
import { findDuplicateAccount, findPrivateBrowser, getChatgptLoginPreflight, parseDeviceAuthOutput, privateBrowserArgs, publicProxyConfig, resolveCodexLaunch, summarizeCodexLaunchFailure } from '../src/admin.js'
import { acquireActiveAccountWithRetry, handleChatGptSub, poolAvailabilityDetails, refreshBelowReserveAccounts, sendWithAccountRotation } from '../src/routes/chatgpt-sub.js'
import { getRouteDecisions, recordRouteDecision, resetRouteDecisions } from '../src/route-decisions.js'
import { decryptConfigSecrets, encryptConfigSecrets, isEncryptedSecret } from '../src/credential-store.js'
import { getProviderHealth, recordProviderOutcome, resetProviderHealth } from '../src/provider-health.js'
import { attachHttpErrorGuide, getHttpErrorGuide, listHttpErrorGuides } from '../src/error-guide.js'
import { compareRuntimeTrees } from '../src/runtime-info.js'
import { accountPoolDiagnosis, buildAutomaticDiagnosis } from '../src/diagnostics.js'
import { buildRoutingPlan, executeRoutingPlan, isVirtualModel, shouldFallbackResponse } from '../src/smart-routing.js'
import { estimateRequestCost, getPriceCatalog, normalizePriceCatalog } from '../src/pricing.js'
import { budgetDecision, getCostReport } from '../src/cost-governance.js'

describe('请求元数据、账号统计和日志脱敏', () => {
  it('生成标准路由响应头', () => {
    const headers = proxyMetaHeaders({
      proxyMeta: {
        requestId: 'req_test',
        startedAt: Date.now() - 10,
        provider: 'chatgpt-sub',
        accountId: 'acct_test',
        model: 'gpt-test',
        fallbackAttempts: 2
      }
    })
    assert.strictEqual(headers['x-codex-proxy-request-id'], 'req_test')
    assert.strictEqual(headers['x-codex-proxy-provider'], 'chatgpt-sub')
    assert.strictEqual(headers['x-codex-proxy-account'], 'acct_test')
    assert.strictEqual(headers['x-codex-proxy-fallback-attempts'], '2')
  })

  it('累计每账号成功率、429 和延迟', () => {
    resetStats()
    recordAccountOutcome('acct-health', { status: 200, latencyMs: 100 })
    recordAccountOutcome('acct-health', { status: 429, latencyMs: 300, errorType: 'rate_limit' })
    const account = getStats().accounts['acct-health']
    assert.strictEqual(account.requests, 2)
    assert.strictEqual(account.success_rate, 50)
    assert.strictEqual(account.rate_limited, 1)
    assert.strictEqual(account.average_latency_ms, 200)
    assert.strictEqual(account.p50_latency_ms, 100)
    assert.strictEqual(account.p95_latency_ms, 300)
    assert.strictEqual(account.windows['1h'].requests, 2)
    assert.strictEqual(account.windows['24h'].success_rate, 50)
    assert.strictEqual(account.windows['7d'].p95_latency_ms, 300)
    recordOperationalEvent('account_switch', { provider: 'chatgpt-sub', fromAccountId: 'a', toAccountId: 'b', reason: '429' })
    recordOperationalEvent('circuit_open', { provider: 'deepseek', reason: 'HTTP 503' })
    assert.strictEqual(getStats().operational_windows['1h'].account_switches, 1)
    assert.strictEqual(getStats().operational_windows['7d'].circuit_opens, 1)
    resetStats()
  })

  it('移除常见 API Key、JWT、Refresh Token 和查询参数秘密', () => {
    const source = 'Bearer secret-token sk-abcdefghijk rt.1.ABCDEFGHIJK eyJabcdefgh.abcdefgh.abcdefgh?api_key=secret'
    const redacted = redactSecrets(source)
    assert.ok(!redacted.includes('secret-token'))
    assert.ok(!redacted.includes('sk-abcdefghijk'))
    assert.ok(!redacted.includes('rt.1.ABCDEFGHIJK'))
    assert.ok(!redacted.includes('eyJabcdefgh.abcdefgh.abcdefgh'))
  })
})

describe('原子配置写入和管理 API', () => {
  it('校验拖拽排序必须包含全部账号且不重复', () => {
    const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    assert.deepStrictEqual(orderChatgptAccounts(accounts, ['c', 'a', 'b']).map(account => account.id), ['c', 'a', 'b'])
    assert.throws(() => orderChatgptAccounts(accounts, ['a', 'a', 'b']), /every account/)
    assert.throws(() => orderChatgptAccounts(accounts, ['a', 'b']), /every account/)
  })

  it('原子写入 JSON 且不遗留临时文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-config-test-'))
    const file = path.join(dir, 'config.json')
    try {
      atomicWriteJson(file, { version: 1 })
      atomicWriteJson(file, { version: 2, ok: true })
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, ok: true })
      assert.deepStrictEqual(fs.readdirSync(dir), ['config.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('管理 API 返回请求 ID、统计和脱敏配置', async () => {
    // `/health` intentionally reports readiness, so do not let this test
    // depend on a developer's local credential file being present.
    const previousDeepseekApiKey = proxyConfig.deepseekApiKey
    proxyConfig.deepseekApiKey = 'test-readiness-key'
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const { port } = server.address()
      const base = `http://127.0.0.1:${port}`
      const health = await fetch(base + '/health')
      assert.strictEqual(health.status, 200)
      assert.match(health.headers.get('x-codex-proxy-request-id'), /^req_/)
      assert.strictEqual((await health.json()).status, 'ok')
      const live = await fetch(base + '/live')
      assert.strictEqual(live.status, 200)
      assert.strictEqual((await live.json()).status, 'ok')

      const configResponse = await fetch(base + '/admin/api/config')
      const configText = await configResponse.text()
      assert.strictEqual(configResponse.status, 200)
      assert.match(configResponse.headers.get('content-type'), /charset=utf-8/i)
      assert.ok(!configText.includes('"access_token"'))
      assert.ok(!configText.includes('"refresh_token"'))
      assert.ok(!configText.includes('"id_token"'))
      const publicConfig = JSON.parse(configText).config
      assert.ok(ACCOUNT_ROUTING_STRATEGIES.includes(publicConfig.chatgptAccountStrategy))
      assert.ok(Number.isFinite(publicConfig.chatgptLowQuotaThreshold))

      const missingRouting = await fetch(base + '/admin/api/chatgpt-accounts/missing/routing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weight: 5 })
      })
      assert.strictEqual(missingRouting.status, 404)
      const missingRoutingError = await missingRouting.json()
      assert.strictEqual(missingRoutingError.error.guide.status, 404)

      const errorGuideResponse = await fetch(base + '/admin/api/error-guide')
      const errorGuide = await errorGuideResponse.json()
      assert.strictEqual(errorGuideResponse.status, 200)
      assert.ok(errorGuide.codes.some(item => item.status === 402))
      assert.ok(errorGuide.codes.some(item => item.status === 503))

      const runtimeResponse = await fetch(base + '/admin/api/runtime-info')
      const runtime = await runtimeResponse.json()
      assert.strictEqual(runtimeResponse.status, 200)
      assert.ok(runtime.runtime.path)
      assert.ok(runtime.runtime.entry.endsWith(path.join('src', 'server.js')))
      assert.ok(runtime.runtime.started_at)

      const statsResponse = await fetch(base + '/admin/api/stats')
      const stats = await statsResponse.json()
      assert.strictEqual(statsResponse.status, 200)
      assert.ok(stats.providers)
      assert.ok(stats.accounts)

      const pricesResponse = await fetch(base + '/admin/api/prices')
      const prices = await pricesResponse.json()
      assert.strictEqual(pricesResponse.status, 200)
      assert.ok(prices.prices['chatgpt-sub:*'])

      const costsResponse = await fetch(base + '/admin/api/costs')
      const costs = await costsResponse.json()
      assert.strictEqual(costsResponse.status, 200)
      assert.strictEqual(costs.currency, 'USD')

      const modelsResponse = await fetch(base + '/v1/models')
      const models = await modelsResponse.json()
      assert.ok(models.data.some(model => model.id === 'auto-reliable' && model.owned_by === 'auto-router'))

      const diagnosticsResponse = await fetch(base + '/admin/api/diagnostics')
      const diagnostics = await diagnosticsResponse.json()
      assert.strictEqual(diagnosticsResponse.status, 200)
      assert.ok(Array.isArray(diagnostics.accounts))
      assert.ok(Number.isFinite(diagnostics.queue.depth))
      assert.strictEqual(typeof diagnostics.process.tls_verification, 'boolean')
      assert.ok(diagnostics.automatic_diagnosis?.summary)

      const diagnosisResponse = await fetch(base + '/admin/api/diagnosis?status=503&type=account_pool_exhausted')
      const diagnosis = await diagnosisResponse.json()
      assert.strictEqual(diagnosisResponse.status, 200)
      assert.strictEqual(diagnosis.request.status, 503)
      assert.ok(Array.isArray(diagnosis.issues))
    } finally {
      await new Promise(resolve => server.close(resolve))
      proxyConfig.deepseekApiKey = previousDeepseekApiKey
    }
  })
})

describe('官方安全登录隔离', () => {
  it('登录预检汇总 CLI、app-server、浏览器和修复命令', () => {
    const preflight = getChatgptLoginPreflight({
      launch: {
        command: 'codex.exe',
        source: 'VS Code Codex 扩展',
        version: 'codex-cli 0.144.0',
        checks: [
          { source: '全局 npm Codex CLI', command: 'node.exe', ok: false, error: '缺少平台运行包' },
          { source: 'VS Code Codex 扩展', command: 'codex.exe', ok: true, version: 'codex-cli 0.144.0', app_server: true }
        ]
      },
      browser: { kind: 'edge', executable: 'msedge.exe' }
    })
    assert.strictEqual(preflight.ok, true)
    assert.strictEqual(preflight.selected.source, 'VS Code Codex 扩展')
    assert.strictEqual(preflight.oauth.app_server_available, true)
    assert.strictEqual(preflight.browser.kind, 'edge')
    assert.ok(preflight.repair_commands.some(command => command.includes('@openai/codex@latest')))
  })

  it('全局 npm Codex 损坏时回退到可用的原生 Codex', () => {
    const candidates = [
      { command: 'node.exe', argsPrefix: ['codex.js'], source: '全局 npm Codex CLI' },
      { command: 'codex.exe', argsPrefix: [], source: 'VS Code Codex 扩展' }
    ]
    const launch = resolveCodexLaunch({
      candidates,
      probe: candidate => candidate.command === 'codex.exe'
        ? { ok: true, version: 'codex-cli 0.144.0' }
        : { ok: false, error: '缺少平台运行包' }
    })

    assert.strictEqual(launch.command, 'codex.exe')
    assert.strictEqual(launch.source, 'VS Code Codex 扩展')
    assert.strictEqual(launch.version, 'codex-cli 0.144.0')
    assert.deepStrictEqual(launch.failures, ['全局 npm Codex CLI：缺少平台运行包'])
  })

  it('登录启动错误不会只显示 Node.js 版本号', () => {
    const stderr = `Error: Missing optional dependency @openai/codex-win32-x64. Reinstall Codex
    at findCodexExecutable (codex.js:105:9)
Node.js v24.11.1`
    assert.strictEqual(
      summarizeCodexLaunchFailure(stderr),
      '全局 Codex CLI 安装不完整，缺少 @openai/codex-win32-x64'
    )
    assert.strictEqual(
      summarizeCodexLaunchFailure('Error: app-server failed\nNode.js v24.11.1'),
      'app-server failed'
    )
  })

  it('解析设备授权地址和用户代码', () => {
    const parsed = parseDeviceAuthOutput(`
      Open \u001b[36mhttps://auth.openai.com/codex/device\u001b[0m in your browser
      Enter code \u001b[1mABCD-EFGH\u001b[0m
    `)
    assert.strictEqual(parsed.verificationUrl, 'https://auth.openai.com/codex/device')
    assert.strictEqual(parsed.userCode, 'ABCD-EFGH')
  })

  it('识别重复账号，避免官方登录覆盖池中已有账号', () => {
    const accounts = [
      { id: 'local-a', account_id: 'upstream-a' },
      { id: 'local-b', account_id: 'upstream-b' }
    ]
    assert.strictEqual(findDuplicateAccount(accounts, 'upstream-b').id, 'local-b')
    assert.strictEqual(findDuplicateAccount(accounts, 'upstream-c'), null)
  })

  it('为常见浏览器生成正确的私密窗口启动参数', () => {
    const url = 'https://auth.openai.com/codex/device'
    assert.deepStrictEqual(privateBrowserArgs('chrome', url), ['--incognito', '--new-window', url])
    assert.deepStrictEqual(privateBrowserArgs('edge', url), ['--inprivate', '--new-window', url])
    assert.deepStrictEqual(privateBrowserArgs('firefox', url), ['-private-window', url])
    assert.strictEqual(privateBrowserArgs('unknown', url), null)
  })

  it('优先选择用户默认浏览器的已安装实例', () => {
    const browser = findPrivateBrowser({
      preferredKind: 'edge',
      exists: executable => executable?.toLowerCase().endsWith('msedge.exe')
    })
    assert.strictEqual(browser.kind, 'edge')
    assert.match(browser.executable, /msedge\.exe$/i)
  })
})
