import './helpers/test-storage-root.js'
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

describe('模型解析', () => {
  it('解析 body.model', () => {
    assert.strictEqual(resolveCodexModel({ model: 'gpt-5.5' }).model, 'gpt-5.5')
  })
  it('回退到默认模型', () => {
    assert.ok(resolveCodexModel({}).model)
  })
})

describe('账号备注管理', () => {
  it('可以改名且不改变其他账号字段', () => {
    const accounts = [{ id: 'a', label: '旧名称', routing_enabled: true }, { id: 'b', label: 'B' }]
    const renamed = renameChatgptAccountInList(accounts, 'a', '  工作账号  ')
    assert.strictEqual(renamed[0].label, '工作账号')
    assert.strictEqual(renamed[0].routing_enabled, true)
    assert.strictEqual(renamed[1], accounts[1])
  })

  it('拒绝空名称和不存在的账号', () => {
    assert.throws(() => renameChatgptAccountInList([{ id: 'a' }], 'a', '  '), /不能为空/)
    assert.throws(() => renameChatgptAccountInList([{ id: 'a' }], 'missing', '名称'), /not found/)
  })
})

describe('安全配置快照', () => {
  const current = {
    default_model: 'gpt-5.6-sol',
    deepseek_api_key: 'deep-current',
    openai_api_key: 'openai-current',
    active_chatgpt_account_id: 'acct-current',
    chatgpt_accounts: [{ id: 'acct-current', refresh_token: 'refresh-current' }],
    relays: [{ id: 'relay-a', name: '当前节点', api_key: 'relay-current' }]
  }

  it('设置快照不包含账号和凭据', () => {
    const snapshot = configForSettingsSnapshot(current)
    assert.strictEqual(snapshot.deepseek_api_key, undefined)
    assert.strictEqual(snapshot.openai_api_key, undefined)
    assert.strictEqual(snapshot.chatgpt_accounts, undefined)
    assert.strictEqual(snapshot.active_chatgpt_account_id, undefined)
    assert.strictEqual(snapshot.relays[0].api_key, undefined)
    assert.strictEqual(snapshot._snapshot.scope, 'settings-only')
  })

  it('回滚旧快照也不会回退 Token、API Key 和活动账号', () => {
    const legacySnapshot = {
      default_model: 'gpt-5.5',
      deepseek_api_key: 'deep-stale',
      openai_api_key: 'openai-stale',
      active_chatgpt_account_id: 'acct-stale',
      chatgpt_accounts: [{ id: 'acct-stale', refresh_token: 'refresh-stale' }],
      relays: [{ id: 'relay-a', name: '旧节点', api_key: 'relay-stale' }]
    }
    const restored = mergeSettingsSnapshot(legacySnapshot, current)
    assert.strictEqual(restored.default_model, 'gpt-5.5')
    assert.strictEqual(restored.deepseek_api_key, 'deep-current')
    assert.strictEqual(restored.openai_api_key, 'openai-current')
    assert.strictEqual(restored.active_chatgpt_account_id, 'acct-current')
    assert.deepStrictEqual(restored.chatgpt_accounts, current.chatgpt_accounts)
    assert.strictEqual(restored.relays[0].name, '旧节点')
    assert.strictEqual(restored.relays[0].api_key, 'relay-current')
  })
})

describe('运行版本与部署一致性', () => {
  it('逐文件识别工作区和安装目录是否一致', () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-source-'))
    const install = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-install-'))
    try {
      fs.writeFileSync(path.join(source, 'a.js'), 'same')
      fs.writeFileSync(path.join(install, 'a.js'), 'same')
      fs.writeFileSync(path.join(source, 'b.js'), 'new')
      fs.writeFileSync(path.join(install, 'b.js'), 'old')
      fs.writeFileSync(path.join(source, 'c.js'), 'missing install')

      const mismatch = compareRuntimeTrees(source, install, ['a.js', 'b.js', 'c.js'])
      assert.strictEqual(mismatch.synchronized, false)
      assert.strictEqual(mismatch.checked_files, 3)
      assert.deepStrictEqual(
        mismatch.differences.map(item => [item.file, item.status]),
        [['b.js', 'content_mismatch'], ['c.js', 'missing_installation']]
      )

      fs.copyFileSync(path.join(source, 'b.js'), path.join(install, 'b.js'))
      fs.copyFileSync(path.join(source, 'c.js'), path.join(install, 'c.js'))
      assert.strictEqual(compareRuntimeTrees(source, install, ['a.js', 'b.js', 'c.js']).synchronized, true)
    } finally {
      fs.rmSync(source, { recursive: true, force: true })
      fs.rmSync(install, { recursive: true, force: true })
    }
  })
})

describe('账号备份安全恢复', () => {
  it('仅补回缺失账号，不覆盖当前账号的新 Token 和名称', () => {
    const current = [{ id: 'current', account_id: 'identity-a', label: '新名称', refresh_token: 'new-token' }]
    const backup = [
      { id: 'old', account_id: 'identity-a', label: '旧名称', refresh_token: 'old-token' },
      { id: 'restored', account_id: 'identity-b', label: '待恢复', refresh_token: 'backup-token' }
    ]
    const merged = mergeAccountBackup(current, backup)
    assert.strictEqual(merged.length, 2)
    assert.strictEqual(merged[0], current[0])
    assert.strictEqual(merged[0].refresh_token, 'new-token')
    assert.strictEqual(merged[1].account_id, 'identity-b')
  })
})

describe('本机凭据加密', () => {
  it('加密并完整恢复配置中的全部敏感字段', () => {
    const key = Buffer.alloc(32, 7)
    const plain = {
      deepseek_api_key: 'deep-secret',
      openai_api_key: 'openai-secret',
      relays: [{ id: 'r', api_key: 'relay-secret' }],
      chatgpt_accounts: [{
        id: 'a',
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        id_token: 'id-secret',
        label: '工作账号'
      }]
    }
    const encrypted = encryptConfigSecrets(plain, key)
    assert.ok(isEncryptedSecret(encrypted.deepseek_api_key))
    assert.ok(isEncryptedSecret(encrypted.relays[0].api_key))
    assert.ok(isEncryptedSecret(encrypted.chatgpt_accounts[0].refresh_token))
    assert.strictEqual(encrypted.chatgpt_accounts[0].label, '工作账号')
    assert.deepStrictEqual(decryptConfigSecrets(encrypted, key), plain)
  })

  it('错误密钥无法解密，避免静默返回损坏凭据', () => {
    const encrypted = encryptConfigSecrets({ openai_api_key: 'secret' }, Buffer.alloc(32, 1))
    assert.throws(() => decryptConfigSecrets(encrypted, Buffer.alloc(32, 2)))
  })
})

describe('路由决策记录', () => {
  it('记录选择和跳过原因且不保留敏感字段', () => {
    resetRouteDecisions()
    recordRouteDecision({
      requestId: 'req-1',
      model: 'gpt-5.6-sol',
      provider: 'chatgpt-sub',
      selectedAccountId: 'a',
      accounts: [
        { id: 'a', label: '工作账号', result: 'selected', reason: '已选择', remainingPercent: 66 },
        { id: 'b', label: '备用账号', result: 'skipped', reason: '仅保存，未启用路由', access_token: 'secret' }
      ]
    })
    const [decision] = getRouteDecisions()
    assert.strictEqual(decision.request_id, 'req-1')
    assert.strictEqual(decision.accounts[1].reason, '仅保存，未启用路由')
    assert.strictEqual(decision.accounts[1].access_token, undefined)
  })
})

describe('Provider 健康状态', () => {
  it('区分正常、受限、鉴权异常和上游故障', () => {
    resetProviderHealth()
    recordProviderOutcome('openai-api', { status: 200, latencyMs: 123 })
    assert.strictEqual(getProviderHealth().providers['openai-api'].state, 'healthy')
    recordProviderOutcome('openai-api', { status: 429, latencyMs: 50 })
    assert.strictEqual(getProviderHealth().providers['openai-api'].state, 'degraded')
    recordProviderOutcome('openai-api', { status: 401, latencyMs: 40 })
    assert.strictEqual(getProviderHealth().providers['openai-api'].state, 'auth_error')
    recordProviderOutcome('openai-api', { error: new Error('network failed'), latencyMs: 5000 })
    const health = getProviderHealth().providers['openai-api']
    assert.strictEqual(health.state, 'unhealthy')
    assert.strictEqual(health.consecutive_failures, 1)
    assert.strictEqual(health.last_error, 'network failed')
    assert.strictEqual(health.windows['1h'].requests, 4)
    assert.strictEqual(health.windows['7d'].rate_limited, 1)
  })

  it('后续成功会清零连续失败次数', () => {
    recordProviderOutcome('openai-api', { status: 204, latencyMs: 80 })
    const health = getProviderHealth().providers['openai-api']
    assert.strictEqual(health.state, 'healthy')
    assert.strictEqual(health.consecutive_failures, 0)
    assert.ok(health.last_success_at)
  })
})

describe('自动诊断中心', () => {
  it('分类账号池不可用原因并生成对应的一键动作', () => {
    const original = proxyConfig.chatgptAccounts
    resetStats()
    proxyConfig.chatgptAccounts = [
      { id: 'stored', routing_enabled: false },
      { id: 'auth', routing_enabled: true, status: 'auth_error' },
      { id: 'cool', routing_enabled: true, status: 'cooldown', cooldown_until: Date.now() + 60_000 },
      { id: 'reserve', routing_enabled: true, status: 'active', usage: { primary: { remaining_percent: 5 } } },
      { id: 'busy', routing_enabled: true, status: 'active' }
    ]
    resetAccountRequestCounts()
    try {
      reserveAccountRequest('busy', 'diagnosis-1')
      reserveAccountRequest('busy', 'diagnosis-2')
      reserveAccountRequest('busy', 'diagnosis-3')
      const pool = accountPoolDiagnosis({ model: 'gpt-test' })
      assert.strictEqual(pool.stored_only, 1)
      assert.strictEqual(pool.auth_error, 1)
      assert.strictEqual(pool.cooling, 1)
      assert.strictEqual(pool.below_reserve, 1)
      assert.strictEqual(pool.busy, 1)
      const diagnosis = buildAutomaticDiagnosis({ status: 503, errorType: 'account_pool_exhausted' })
      assert.strictEqual(diagnosis.summary.level, 'critical')
      assert.ok(diagnosis.issues.some(issue => issue.actions.some(item => item.id === 'refresh_quota')))
      assert.ok(diagnosis.issues.some(issue => issue.actions.some(item => item.id === 'official_login')))
    } finally {
      resetAccountRequestCounts()
      proxyConfig.chatgptAccounts = original
      resetStats()
    }
  })

  it('402 明确指向计费而不是盲目重试', () => {
    const diagnosis = buildAutomaticDiagnosis({ status: 402, provider: 'openai-api' })
    const billing = diagnosis.issues.find(issue => issue.id === 'billing')
    assert.ok(billing)
    assert.match(billing.conclusion, /订阅和 API 余额相互独立/)
    assert.ok(!billing.actions.some(item => /重试/.test(item.label)))
  })
})

describe('HTTP 错误码查找表', () => {
  it('解释 402 的计费含义和处理方向', () => {
    const guide = getHttpErrorGuide(402)
    assert.strictEqual(guide.status, 402)
    assert.match(guide.title, /余额|计费/)
    assert.ok(guide.causes.some(value => value.includes('ChatGPT 订阅不等于 API 余额')))
    assert.ok(guide.actions.some(value => value.includes('Provider')))
  })

  it('为账号池耗尽的 503 返回更具体的原因和建议', () => {
    const guide = getHttpErrorGuide(503, 'account_pool_exhausted')
    assert.strictEqual(guide.status, 503)
    assert.match(guide.title, /账号池/)
    assert.ok(guide.causes.some(value => value.includes('并发已满')))
    assert.ok(guide.actions.some(value => value.includes('账号池')))
    assert.strictEqual(guide.help_path, '/admin#help')
  })

  it('给本地 JSON 错误附加机器可读指南但保留原错误', () => {
    const source = { error: { type: 'authentication_error', message: 'invalid token' } }
    const result = attachHttpErrorGuide(401, source)
    assert.strictEqual(result.error.message, 'invalid token')
    assert.strictEqual(result.error.guide.status, 401)
    assert.strictEqual(source.error.guide, undefined)
    assert.ok(listHttpErrorGuides().some(item => item.status === 503))
  })
})

describe('四通道路由分类', () => {
  it('gpt-5.x -> ChatGPT 订阅', () => {
    assert.strictEqual(isChatGptSubModel('gpt-5.5'), true)
    assert.strictEqual(isChatGptSubModel('gpt-5.4'), true)
    assert.strictEqual(isChatGptSubModel('gpt-5.4-mini'), true)
  })
  it('openai-api-* -> OpenAI API', () => {
    assert.strictEqual(isOpenAIApiModel('openai-api-gpt-5.5'), true)
    assert.strictEqual(isOpenAIApiModel('gpt-5.5'), false)
  })
  it('relay-* -> 中转站', () => {
    assert.strictEqual(isRelayModel('relay-myproxy-gpt-5.5'), true)
    assert.strictEqual(isRelayModel('gpt-5.5'), false)
  })
  it('不重叠', () => {
    assert.strictEqual(isChatGptSubModel('openai-api-gpt-5.5'), false)
    assert.strictEqual(isOpenAIApiModel('relay-x-gpt-5.5'), false)
    assert.strictEqual(isRelayModel('gpt-5.5'), false)
  })
})

describe('显式跨 Provider 与虚拟模型路由', () => {
  it('默认不跨 Provider，只有显式开启后才使用配置的回退链', () => {
    const original = {
      enabled: proxyConfig.crossProviderFallbackEnabled,
      chain: proxyConfig.fallbackChain,
      accounts: proxyConfig.chatgptAccounts,
      openai: proxyConfig.openaiApiKey
    }
    proxyConfig.fallbackChain = [
      { provider: 'chatgpt-sub', model: 'gpt-main' },
      { provider: 'openai-api', model: 'openai-api-gpt-backup' }
    ]
    proxyConfig.chatgptAccounts = [{ id: 'a', routing_enabled: true, access_token: 'token' }]
    proxyConfig.openaiApiKey = 'key'
    try {
      proxyConfig.crossProviderFallbackEnabled = false
      assert.deepStrictEqual(buildRoutingPlan({ headers: {} }, { model: 'gpt-main' }).map(item => item.provider), ['chatgpt-sub'])
      proxyConfig.crossProviderFallbackEnabled = true
      assert.deepStrictEqual(buildRoutingPlan({ headers: {} }, { model: 'gpt-main' }).map(item => item.provider), ['chatgpt-sub', 'openai-api'])
    } finally {
      proxyConfig.crossProviderFallbackEnabled = original.enabled
      proxyConfig.fallbackChain = original.chain
      proxyConfig.chatgptAccounts = original.accounts
      proxyConfig.openaiApiKey = original.openai
    }
  })

  it('auto 系列是显式虚拟模型且 auto-cheap 优先免费订阅线路', () => {
    const original = {
      chain: proxyConfig.fallbackChain,
      accounts: proxyConfig.chatgptAccounts,
      openai: proxyConfig.openaiApiKey
    }
    proxyConfig.fallbackChain = [
      { provider: 'openai-api', model: 'openai-api-gpt-paid' },
      { provider: 'chatgpt-sub', model: 'gpt-subscription' }
    ]
    proxyConfig.chatgptAccounts = [{ id: 'a', routing_enabled: true, access_token: 'token' }]
    proxyConfig.openaiApiKey = 'key'
    try {
      assert.strictEqual(isVirtualModel('auto-reliable'), true)
      const plan = buildRoutingPlan({ headers: {} }, { model: 'auto-cheap' })
      assert.strictEqual(plan[0].provider, 'chatgpt-sub')
      assert.ok(plan.every(item => item.virtualModel === 'auto-cheap'))
    } finally {
      proxyConfig.fallbackChain = original.chain
      proxyConfig.chatgptAccounts = original.accounts
      proxyConfig.openaiApiKey = original.openai
    }
  })

  it('401 和 402 不盲目回退，允许的 503 才进入下一 Provider', async () => {
    assert.strictEqual(shouldFallbackResponse(401, 'authentication_error'), false)
    assert.strictEqual(shouldFallbackResponse(402, 'billing_error'), false)
    assert.strictEqual(shouldFallbackResponse(503, 'upstream_error'), true)
    const original = {
      enabled: proxyConfig.crossProviderFallbackEnabled,
      chain: proxyConfig.fallbackChain,
      accounts: proxyConfig.chatgptAccounts,
      openai: proxyConfig.openaiApiKey
    }
    proxyConfig.crossProviderFallbackEnabled = true
    proxyConfig.fallbackChain = [
      { provider: 'chatgpt-sub', model: 'gpt-main' },
      { provider: 'openai-api', model: 'openai-api-gpt-backup' }
    ]
    proxyConfig.chatgptAccounts = [{ id: 'a', routing_enabled: true, access_token: 'token' }]
    proxyConfig.openaiApiKey = 'key'
    const req = Object.assign(new EventEmitter(), { headers: {}, requestId: 'fallback-test' })
    const real = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
      status: null,
      chunks: [],
      writeHead(status) { this.status = status; this.headersSent = true },
      write(chunk) { this.chunks.push(Buffer.from(chunk)); return true },
      end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true }
    })
    const providers = []
    try {
      await executeRoutingPlan(req, real, { model: 'gpt-main' }, { model: 'gpt-main', bodyModel: 'gpt-main' },
        async (target, response) => {
          providers.push(target.provider)
          if (target.provider === 'chatgpt-sub') {
            response.writeHead(503, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { type: 'upstream_error' } }))
          } else {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end('{"ok":true}')
          }
        })
      assert.deepStrictEqual(providers, ['chatgpt-sub', 'openai-api'])
      assert.strictEqual(real.status, 200)
      assert.strictEqual(Buffer.concat(real.chunks).toString(), '{"ok":true}')
    } finally {
      proxyConfig.crossProviderFallbackEnabled = original.enabled
      proxyConfig.fallbackChain = original.chain
      proxyConfig.chatgptAccounts = original.accounts
      proxyConfig.openaiApiKey = original.openai
    }
  })
})

describe('中转站模型解析', () => {
  it('解析 relay-{id}-{model}', () => {
    const parts = 'relay-myproxy-gpt-5.5'.split('-')
    assert.strictEqual(parts[1], 'myproxy')
    assert.strictEqual(parts.slice(2).join('-'), 'gpt-5.5')
  })
})

describe('buildModelsResponse', () => {
  it('四通道 owned_by', () => {
    const result = buildModelsResponse([
      { slug: 'gpt-5.5' },
      { slug: 'openai-api-gpt-5.5' },
      { slug: 'relay-myproxy-gpt-5.5' },
      { slug: 'deepseek-v4-pro' },
      { slug: 'auto' }
    ])
    assert.strictEqual(result.data.find(m=>m.id==='gpt-5.5').owned_by, 'chatgpt-sub')
    assert.strictEqual(result.data.find(m=>m.id==='openai-api-gpt-5.5').owned_by, 'openai-api')
    assert.strictEqual(result.data.find(m=>m.id==='relay-myproxy-gpt-5.5').owned_by, 'relay')
    assert.strictEqual(result.data.find(m=>m.id==='deepseek-v4-pro').owned_by, 'deepseek')
    assert.strictEqual(result.data.find(m=>m.id==='auto').owned_by, 'auto-router')
  })
})

describe('用量统计', () => {
  it('按天记录总量、Provider 和账号用量并可重置', () => {
    resetStats()
    recordUsage('gpt-5.5', 'chatgpt-sub', 100, 50, 'account-a')
    recordUsage('relay-x-gpt-5.5', 'relay:x', 200, 100)
    recordAccountOutcome('account-a', { status: 200, latencyMs: 120 })
    recordAccountOutcome('account-a', { status: 429, latencyMs: 80, errorType: 'rate_limit' })
    const s = getStats()
    const today = s.daily[statsDayKey()]
    assert.ok(s.providers['chatgpt-sub'])
    assert.ok(s.providers['relay:x'])
    assert.strictEqual(today.requests, 2)
    assert.strictEqual(today.account_attempts, 2)
    assert.strictEqual(today.input_tokens, 300)
    assert.strictEqual(today.output_tokens, 150)
    assert.deepStrictEqual(today.providers['chatgpt-sub'], {
      requests: 1,
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: 0
    })
    assert.deepStrictEqual(today.providers['relay:x'], {
      requests: 1,
      input_tokens: 200,
      output_tokens: 100,
      estimated_cost_usd: 0.0012
    })
    assert.deepStrictEqual(today.accounts['account-a'], {
      requests: 2,
      successes: 1,
      failures: 1,
      rate_limited: 1,
      completed_requests: 1,
      input_tokens: 100,
      output_tokens: 50
    })
    const after = resetStats()
    assert.strictEqual(Object.keys(after.providers).length, 0)
    assert.strictEqual(Object.keys(after.daily).length, 0)
  })
})

describe('价格、成本与预算治理', () => {
  it('按可更新价格目录估算每次、每日和累计成本', () => {
    const catalog = normalizePriceCatalog({
      notice: 'test',
      prices: {
        'openai-api:*': { input_per_million: 2, output_per_million: 8, kind: 'test' }
      }
    }, '2026-07-15T00:00:00.000Z')
    const estimate = estimateRequestCost('openai-api', 'openai-api-gpt-test', 1_000_000, 500_000, catalog)
    assert.strictEqual(estimate.estimated_cost_usd, 6)
    assert.ok(getPriceCatalog().prices['chatgpt-sub:*'])
    resetStats()
    recordUsage('openai-api-gpt-test', 'openai-api', 1_000_000, 500_000)
    const report = getCostReport()
    assert.ok(report.total_usd > 0)
    assert.strictEqual(report.today_usd, report.providers['openai-api'].daily_usd)
    resetStats()
  })

  it('达到 Provider 日预算后返回可执行的 fallback 或 stop 决策', () => {
    const original = proxyConfig.providerBudgets
    resetStats()
    proxyConfig.providerBudgets = {
      'openai-api': { daily_usd: 0.01, monthly_usd: 1, action: 'fallback' }
    }
    try {
      recordUsage('openai-api-gpt-test', 'openai-api', 1_000_000, 0)
      const decision = budgetDecision('openai-api')
      assert.strictEqual(decision.exceeded, true)
      assert.strictEqual(decision.reason, 'daily_budget_exceeded')
      assert.strictEqual(decision.action, 'fallback')
    } finally {
      proxyConfig.providerBudgets = original
      resetStats()
    }
  })

  it('预算 stop 门禁在请求上游前返回 402', async () => {
    const original = {
      budgets: proxyConfig.providerBudgets,
      enabled: proxyConfig.crossProviderFallbackEnabled,
      upstream: proxyConfig.openaiApiUpstream
    }
    resetStats()
    proxyConfig.crossProviderFallbackEnabled = false
    proxyConfig.openaiApiUpstream = 'official'
    proxyConfig.providerBudgets = {
      'openai-api': { daily_usd: 0.01, monthly_usd: 1, action: 'stop' }
    }
    recordUsage('openai-api-gpt-test', 'openai-api', 1_000_000, 0)
    let dispatched = false
    try {
      await assert.rejects(
        executeRoutingPlan(
          { headers: {}, requestId: 'budget-stop' },
          Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false }),
          { model: 'openai-api-gpt-test' },
          { model: 'openai-api-gpt-test', bodyModel: 'openai-api-gpt-test' },
          async () => { dispatched = true }
        ),
        error => error.code === 'BUDGET_EXCEEDED' && error.status === 402
      )
      assert.strictEqual(dispatched, false)
    } finally {
      proxyConfig.providerBudgets = original.budgets
      proxyConfig.crossProviderFallbackEnabled = original.enabled
      proxyConfig.openaiApiUpstream = original.upstream
      resetStats()
    }
  })
})
