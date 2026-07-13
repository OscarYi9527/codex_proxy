import { describe, it } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCodexModel, isChatGptSubModel, isOpenAIApiModel, isRelayModel, parseRelayModel, buildModelsResponse, getThreadId } from '../src/models.js'
import { recordUsage, recordAccountOutcome, getStats, resetStats, saveStats } from '../src/stats.js'
import { ACCOUNT_ROUTING_STRATEGIES, accountActiveRequestCount, accountConcurrencyLimit, accountRemainingPercent, accountUsageIsFresh, calculateUsageForecast, cooldownMsFromResponseText, ensureFreshToken, extractUsageFromBody, extractUsageFromHeaders, normalizeAccountRoutingStrategy, noteAccountAdaptiveOutcome, noteAccountSuccess, pickActiveAccount, refreshAccountUsage, releaseAccountRequest, renewAccountRequestLease, reserveAccountRequest, resetAccountRequestCounts, resetAccountStickiness } from '../src/chatgpt-accounts.js'
import { proxyConfig, atomicWriteJson, configForSettingsSnapshot, mergeAccountBackup, mergeSettingsSnapshot, orderChatgptAccounts, renameChatgptAccountInList } from '../src/config.js'
import { assertCircuitAvailable, getCircuitStates, recordCircuitResult, resetCircuits } from '../src/circuit-breaker.js'
import { fetchWithRetry, proxyMetaHeaders, retryAfterMs } from '../src/server-utils.js'
import { redactSecrets } from '../src/logger.js'
import { createServer } from '../src/server.js'
import { findDuplicateAccount, findPrivateBrowser, parseDeviceAuthOutput, privateBrowserArgs } from '../src/admin.js'
import { acquireActiveAccountWithRetry, refreshBelowReserveAccounts } from '../src/routes/chatgpt-sub.js'
import { getRouteDecisions, recordRouteDecision, resetRouteDecisions } from '../src/route-decisions.js'
import { decryptConfigSecrets, encryptConfigSecrets, isEncryptedSecret } from '../src/credential-store.js'
import { getProviderHealth, recordProviderOutcome, resetProviderHealth } from '../src/provider-health.js'

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
  })

  it('后续成功会清零连续失败次数', () => {
    recordProviderOutcome('openai-api', { status: 204, latencyMs: 80 })
    const health = getProviderHealth().providers['openai-api']
    assert.strictEqual(health.state, 'healthy')
    assert.strictEqual(health.consecutive_failures, 0)
    assert.ok(health.last_success_at)
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
      { slug: 'deepseek-v4-pro' }
    ])
    assert.strictEqual(result.data.find(m=>m.id==='gpt-5.5').owned_by, 'chatgpt-sub')
    assert.strictEqual(result.data.find(m=>m.id==='openai-api-gpt-5.5').owned_by, 'openai-api')
    assert.strictEqual(result.data.find(m=>m.id==='relay-myproxy-gpt-5.5').owned_by, 'relay')
    assert.strictEqual(result.data.find(m=>m.id==='deepseek-v4-pro').owned_by, 'deepseek')
  })
})

describe('用量统计', () => {
  it('记录和重置', () => {
    resetStats()
    recordUsage('gpt-5.5', 'chatgpt-sub', 100, 50)
    recordUsage('relay-x-gpt-5.5', 'relay:x', 200, 100)
    const s = getStats()
    assert.ok(s.providers['chatgpt-sub'])
    assert.ok(s.providers['relay:x'])
    const after = resetStats()
    assert.strictEqual(Object.keys(after.providers).length, 0)
  })
})

describe('ChatGPT 账号额度解析', () => {
  it('正确区分绝对重置时间和剩余秒数', () => {
    const now = 1_800_000_000_000
    assert.strictEqual(
      cooldownMsFromResponseText('{"reset_at":1800000060}', now),
      60_000
    )
    assert.strictEqual(
      cooldownMsFromResponseText('{"resets_in":60}', now),
      60_000
    )
  })

  it('解析当前 wham usage 的 rate_limit 窗口格式并计算剩余额度', () => {
    const usage = extractUsageFromBody({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 9,
          limit_window_seconds: 18000,
          reset_after_seconds: 16103
        },
        secondary_window: {
          used_percent: 1,
          limit_window_seconds: 604800,
          reset_at: 1780000000000
        }
      }
    })

    assert.strictEqual(usage.plan_type, 'plus')
    assert.deepStrictEqual(usage.primary, {
      used_percent: 9,
      remaining_percent: 91,
      window_minutes: 300,
      resets_at: null,
      reset_after_seconds: 16103
    })
    assert.strictEqual(usage.secondary.remaining_percent, 99)
    assert.strictEqual(usage.secondary.window_minutes, 10080)
    assert.strictEqual(usage.secondary.resets_at, 1780000000)
  })

  it('兼容旧 rate_limits.primary 格式并限制异常百分比', () => {
    const usage = extractUsageFromBody({
      rate_limits: {
        plan_type: 'pro',
        primary: { usedPercent: 120, windowMinutes: 300 },
        secondary: { used_percent: -5, window_minutes: 10080 }
      }
    })

    assert.strictEqual(usage.plan_type, 'pro')
    assert.strictEqual(usage.primary.used_percent, 100)
    assert.strictEqual(usage.primary.remaining_percent, 0)
    assert.strictEqual(usage.secondary.used_percent, 0)
    assert.strictEqual(usage.secondary.remaining_percent, 100)
  })

  it('从普通响应头提取额度并计算剩余百分比', () => {
    const usage = extractUsageFromHeaders(new Headers({
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '600'
    }))

    assert.strictEqual(usage.primary.used_percent, 42)
    assert.strictEqual(usage.primary.remaining_percent, 58)
    assert.strictEqual(usage.secondary, null)
  })
})

describe('额度感知和会话粘性账号选择', () => {
  it('避让低额度账号并选择剩余额度最多的账号', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'low', status: 'active', usage: { primary: { used_percent: 95 } } },
      { id: 'mid', status: 'active', usage: { primary: { used_percent: 40 } } },
      { id: 'high', status: 'active', usage: { primary: { used_percent: 10 } } }
    ]
    try {
      assert.strictEqual(accountRemainingPercent(proxyConfig.chatgptAccounts[0]), 5)
      assert.strictEqual(pickActiveAccount().id, 'high')
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('primary 99% 且 secondary 86% 时不会被误判为低额度', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [{
      id: 'healthy',
      status: 'active',
      routing_enabled: true,
      usage: {
        primary: { remaining_percent: 99 },
        secondary: { remaining_percent: 86 }
      }
    }]
    try {
      assert.strictEqual(accountRemainingPercent(proxyConfig.chatgptAccounts[0]), 86)
      assert.strictEqual(pickActiveAccount(null, { lowQuotaThreshold: 10 }).id, 'healthy')
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('所有已知额度都达到安全余量时停止路由', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'reserve-a', status: 'active', routing_enabled: true, usage: { primary: { remaining_percent: 10 } } },
      { id: 'reserve-b', status: 'active', routing_enabled: true, usage: { primary: { remaining_percent: 4 } } }
    ]
    try {
      assert.strictEqual(pickActiveAccount(null, { lowQuotaThreshold: 10 }), null)
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('模型级 429 只跳过该账号上的对应模型', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      {
        id: 'model-limited',
        status: 'active',
        routing_enabled: true,
        model_cooldowns: { 'gpt-test-a': Date.now() + 60_000 }
      },
      { id: 'fallback', status: 'active', routing_enabled: true }
    ]
    try {
      assert.strictEqual(pickActiveAccount(null, { strategy: 'priority', model: 'gpt-test-a' }).id, 'fallback')
      assert.strictEqual(pickActiveAccount(null, { strategy: 'priority', model: 'gpt-test-b' }).id, 'model-limited')
      assert.strictEqual(proxyConfig.chatgptAccounts[0].status, 'active')
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('完全跳过仅保存、未启用路由的账号', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'stored-only', status: 'active', routing_enabled: false, usage: { primary: { remaining_percent: 100 } } },
      { id: 'enabled', status: 'active', routing_enabled: true, usage: { primary: { remaining_percent: 20 } } }
    ]
    try {
      assert.strictEqual(pickActiveAccount(null, { strategy: 'headroom' }).id, 'enabled')
      proxyConfig.chatgptAccounts[1].routing_enabled = false
      assert.strictEqual(pickActiveAccount(null, { strategy: 'headroom' }), null)
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('稳定模式限制单账号并发为 3，并优先选择空闲账号', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'busy', status: 'active', routing_enabled: true },
      { id: 'idle', status: 'active', routing_enabled: true }
    ]
    resetAccountRequestCounts()
    try {
      assert.strictEqual(reserveAccountRequest('busy'), true)
      assert.strictEqual(reserveAccountRequest('busy'), true)
      assert.strictEqual(reserveAccountRequest('busy'), true)
      assert.strictEqual(reserveAccountRequest('busy'), false)
      assert.strictEqual(accountActiveRequestCount('busy'), 3)
      assert.strictEqual(pickActiveAccount(null, { strategy: 'priority' }).id, 'idle')
      releaseAccountRequest('busy')
      assert.strictEqual(accountActiveRequestCount('busy'), 2)
      releaseAccountRequest('busy')
      assert.strictEqual(accountActiveRequestCount('busy'), 1)
      releaseAccountRequest('busy')
      assert.strictEqual(accountActiveRequestCount('busy'), 0)
      assert.strictEqual(pickActiveAccount(null, { strategy: 'priority' }).id, 'busy')
    } finally {
      resetAccountRequestCounts()
      proxyConfig.chatgptAccounts = original
    }
  })

  it('识别超过 30 分钟的陈旧额度数据', () => {
    const now = Date.now()
    assert.strictEqual(accountUsageIsFresh({ usage_updated_at: new Date(now - 5 * 60_000).toISOString() }, now), true)
    assert.strictEqual(accountUsageIsFresh({ usage_updated_at: new Date(now - 31 * 60_000).toISOString() }, now), false)
    assert.strictEqual(accountUsageIsFresh({}, now), false)
  })

  it('同一会话复用最后成功账号，但不会粘住低额度账号', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'first', status: 'active', usage: { primary: { remaining_percent: 60 } } },
      { id: 'second', status: 'active', usage: { primary: { remaining_percent: 80 } } }
    ]
    resetAccountStickiness()
    try {
      noteAccountSuccess('session-a', 'first')
      assert.strictEqual(pickActiveAccount(null, { sessionKey: 'session-a', strategy: 'lkgp' }).id, 'first')
      proxyConfig.chatgptAccounts[0].usage.primary.remaining_percent = 5
      assert.strictEqual(pickActiveAccount(null, { sessionKey: 'session-a', strategy: 'lkgp' }).id, 'second')
    } finally {
      resetAccountStickiness()
      proxyConfig.chatgptAccounts = original
    }
  })

  it('支持全部可选账号路由模式', () => {
    assert.deepStrictEqual(ACCOUNT_ROUTING_STRATEGIES, [
      'priority', 'round-robin', 'headroom', 'least-used', 'latency',
      'reliable', 'weighted', 'random', 'lkgp'
    ])
    for (const strategy of ACCOUNT_ROUTING_STRATEGIES) {
      assert.strictEqual(normalizeAccountRoutingStrategy(strategy), strategy)
    }
    assert.strictEqual(normalizeAccountRoutingStrategy('unknown'), 'headroom')
  })

  it('priority、round-robin、least-used 和 latency 按各自指标选择', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'a', status: 'active', usage: { primary: { remaining_percent: 60 } } },
      { id: 'b', status: 'active', usage: { primary: { remaining_percent: 70 } } },
      { id: 'c', status: 'active', usage: { primary: { remaining_percent: 80 } } }
    ]
    resetStats()
    resetAccountStickiness()
    try {
      recordAccountOutcome('a', { status: 200, latencyMs: 500 })
      recordAccountOutcome('a', { status: 200, latencyMs: 500 })
      recordAccountOutcome('b', { status: 200, latencyMs: 100 })
      assert.strictEqual(pickActiveAccount(null, { strategy: 'priority' }).id, 'a')
      assert.strictEqual(pickActiveAccount(null, { strategy: 'round-robin' }).id, 'a')
      assert.strictEqual(pickActiveAccount(null, { strategy: 'round-robin' }).id, 'b')
      assert.strictEqual(pickActiveAccount(null, { strategy: 'least-used' }).id, 'c')
      assert.strictEqual(pickActiveAccount(null, { strategy: 'latency' }).id, 'b')
    } finally {
      resetStats()
      resetAccountStickiness()
      proxyConfig.chatgptAccounts = original
    }
  })
})

describe('Provider 熔断器', () => {
  it('连续 provider 级失败后打开并可半开恢复', () => {
    resetCircuits()
    recordCircuitResult('test-provider', { status: 503, failureThreshold: 2 })
    recordCircuitResult('test-provider', { status: 503, failureThreshold: 2 })
    assert.strictEqual(getCircuitStates()[0].state, 'open')
    assert.throws(() => assertCircuitAvailable('test-provider'), /circuit/)
    assert.doesNotThrow(() => assertCircuitAvailable('test-provider', { resetTimeoutMs: 0 }))
    recordCircuitResult('test-provider', { status: 200 })
    assert.strictEqual(getCircuitStates()[0].state, 'closed')
    resetCircuits()
  })

  it('429 不触发 provider 熔断', () => {
    resetCircuits()
    for (let i = 0; i < 5; i++) recordCircuitResult('quota-provider', { status: 429 })
    assert.strictEqual(getCircuitStates()[0].state, 'closed')
    resetCircuits()
  })
})

describe('稳定重试策略', () => {
  it('解析 Retry-After 秒数和 HTTP 日期', () => {
    assert.strictEqual(retryAfterMs(new Response('', { headers: { 'retry-after': '2' } })), 2000)
    assert.strictEqual(
      retryAfterMs(new Response('', { headers: { 'retry-after': 'Wed, 01 Jan 2031 00:00:10 GMT' } }), Date.parse('2031-01-01T00:00:00Z')),
      10_000
    )
  })

  it('调用方取消后不会继续发起上游请求', async () => {
    resetProviderHealth()
    const controller = new AbortController()
    controller.abort(new Error('Client disconnected'))
    let calls = 0
    await assert.rejects(
      fetchWithRetry(async () => {
        calls++
        return new Response('{}')
      }, 'https://example.invalid', { signal: controller.signal, attemptTimeoutMs: 100, circuitKey: 'cancelled-provider' }, 2),
      /Client disconnected/
    )
    assert.strictEqual(calls, 0)
    assert.strictEqual(getProviderHealth().providers['cancelled-provider'], undefined)
  })

  it('账号池可以让 429 立即交给账号轮换而不原账号重试', async () => {
    let calls = 0
    const response = await fetchWithRetry(async () => {
      calls += 1
      return new Response('limited', { status: 429 })
    }, 'https://example.test', {
      retryStatuses: [502, 503, 504]
    }, 2)
    assert.strictEqual(response.status, 429)
    assert.strictEqual(calls, 1)
  })

  it('账号短暂忙碌时进入队列并在释放后原子占用', async () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'queued-account', status: 'active', routing_enabled: true }
    ]
    resetAccountRequestCounts()
    try {
      assert.strictEqual(reserveAccountRequest('queued-account'), true)
      assert.strictEqual(reserveAccountRequest('queued-account'), true)
      assert.strictEqual(reserveAccountRequest('queued-account'), true)
      setTimeout(() => releaseAccountRequest('queued-account'), 30)
      const acquired = await acquireActiveAccountWithRetry(
        { aborted: false, headers: {} },
        'gpt-test',
        null,
        'queue-test'
      )
      assert.strictEqual(acquired.id, 'queued-account')
      assert.strictEqual(accountActiveRequestCount('queued-account'), 3)
      releaseAccountRequest('queued-account')
      releaseAccountRequest('queued-account')
      releaseAccountRequest('queued-account')
    } finally {
      resetAccountRequestCounts()
      proxyConfig.chatgptAccounts = original
    }
  })

  it('低额度缓存超过两分钟时按需刷新并恢复账号选择', async () => {
    const original = proxyConfig.chatgptAccounts
    const account = {
      id: 'quota-reset-account',
      status: 'active',
      routing_enabled: true,
      usage: {
        primary: { remaining_percent: 9 },
        secondary: { remaining_percent: 86 }
      },
      usage_updated_at: new Date(Date.now() - 6 * 60_000).toISOString()
    }
    proxyConfig.chatgptAccounts = [account]
    let refreshCalls = 0
    try {
      assert.strictEqual(pickActiveAccount(null, { lowQuotaThreshold: 10 }), null)
      const refreshed = await refreshBelowReserveAccounts(
        async () => {},
        'gpt-test',
        null,
        async target => {
          refreshCalls++
          target.usage.primary.remaining_percent = 99
          target.usage_updated_at = new Date().toISOString()
        }
      )
      assert.strictEqual(refreshed, true)
      assert.strictEqual(refreshCalls, 1)
      assert.strictEqual(pickActiveAccount(null, { lowQuotaThreshold: 10 }).id, account.id)
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })
})

describe('自适应并发、租约和刷新单飞', () => {
  it('429 降低并发，连续成功后逐步恢复', () => {
    resetAccountRequestCounts()
    assert.strictEqual(accountConcurrencyLimit('adaptive'), 3)
    noteAccountAdaptiveOutcome('adaptive', { status: 429 })
    assert.strictEqual(accountConcurrencyLimit('adaptive'), 2)
    for (let index = 0; index < 8; index++) {
      noteAccountAdaptiveOutcome('adaptive', { status: 200, latencyMs: 100 })
    }
    assert.strictEqual(accountConcurrencyLimit('adaptive'), 3)
    resetAccountRequestCounts()
  })

  it('租约支持续期和按请求精确释放', () => {
    resetAccountRequestCounts()
    assert.strictEqual(reserveAccountRequest('leased', 'request-a'), true)
    assert.strictEqual(reserveAccountRequest('leased', 'request-b'), true)
    assert.strictEqual(renewAccountRequestLease('leased', 'request-a'), true)
    releaseAccountRequest('leased', 'request-a')
    assert.strictEqual(accountActiveRequestCount('leased'), 1)
    releaseAccountRequest('leased', 'request-b')
    assert.strictEqual(accountActiveRequestCount('leased'), 0)
  })

  it('并发 Token 刷新只调用一次上游', async () => {
    const account = {
      id: 'singleflight',
      refresh_token: 'refresh',
      expires_at: 0
    }
    let calls = 0
    const fetchImpl = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 20))
      throw new Error('temporary network failure')
    }
    const results = await Promise.allSettled([
      ensureFreshToken(account, fetchImpl),
      ensureFreshToken(account, fetchImpl)
    ])
    assert.strictEqual(calls, 1)
    assert.ok(results.every(result => result.status === 'rejected'))
    assert.ok(results.every(result => result.reason.code === 'TOKEN_REFRESH_TRANSIENT'))
  })

  it('并发额度刷新合并为一次上游请求', async () => {
    const originalActive = proxyConfig.activeChatgptAccountId
    proxyConfig.activeChatgptAccountId = null
    const account = {
      id: 'usage-singleflight',
      account_id: 'upstream-account',
      access_token: 'access',
      expires_at: Date.now() + 3_600_000
    }
    let calls = 0
    const fetchImpl = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response('temporary failure', { status: 503 })
    }
    try {
      const results = await Promise.allSettled([
        refreshAccountUsage(account, fetchImpl),
        refreshAccountUsage(account, fetchImpl)
      ])
      assert.strictEqual(calls, 1)
      assert.ok(results.every(result => result.status === 'rejected'))
    } finally {
      proxyConfig.activeChatgptAccountId = originalActive
    }
  })

  it('根据额度历史预测到达安全线的时间', () => {
    const now = Date.now()
    const forecast = calculateUsageForecast({
      usage_history: [
        { at: new Date(now - 2 * 3_600_000).toISOString(), primary_remaining: 80 },
        { at: new Date(now).toISOString(), primary_remaining: 60 }
      ]
    }, 10, now)
    assert.strictEqual(forecast.primary.percent_per_hour, 10)
    assert.strictEqual(forecast.primary.estimated_minutes_to_reserve, 300)
  })
})

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

      const statsResponse = await fetch(base + '/admin/api/stats')
      const stats = await statsResponse.json()
      assert.strictEqual(statsResponse.status, 200)
      assert.ok(stats.providers)
      assert.ok(stats.accounts)

      const diagnosticsResponse = await fetch(base + '/admin/api/diagnostics')
      const diagnostics = await diagnosticsResponse.json()
      assert.strictEqual(diagnosticsResponse.status, 200)
      assert.ok(Array.isArray(diagnostics.accounts))
      assert.ok(Number.isFinite(diagnostics.queue.depth))
      assert.strictEqual(typeof diagnostics.process.tls_verification, 'boolean')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('官方安全登录隔离', () => {
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
