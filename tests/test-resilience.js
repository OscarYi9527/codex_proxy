import './helpers/test-storage-root.js'
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCodexModel, isChatGptSubModel, isOpenAIApiModel, isRelayModel, parseRelayModel, buildModelsResponse, getThreadId } from '../src/models.js'
import { recordUsage, recordAccountOutcome, recordOperationalEvent, getStats, resetStats, saveStats, statsDayKey } from '../src/stats.js'
import { ACCOUNT_ROUTING_STRATEGIES, accountActiveRequestCount, accountConcurrencyLimit, accountCredentialLifecycle, accountPolicyState, accountRemainingPercent, accountUsageIsFresh, calculateUsageForecast, consumeAccountResetCredit, cooldownMsFromResponseText, ensureFreshToken, extractResetCredits, extractUsageFromBody, extractUsageFromHeaders, mergeAccountUsageWindows, normalizeAccountRoutingStrategy, noteAccountAdaptiveOutcome, noteAccountSuccess, pickActiveAccount, refreshAccountResetCredits, refreshAccountUsage, releaseAccountRequest, renewAccountRequestLease, reserveAccountRequest, resetAccountRequestCounts, resetAccountStickiness } from '../src/chatgpt-accounts.js'
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

  it('半开探测请求被取消后不会永久卡死，过期后允许新探测', () => {
    resetCircuits()
    recordCircuitResult('stuck-provider', { status: 503, failureThreshold: 1 })
    assert.strictEqual(getCircuitStates()[0].state, 'open')
    // 进入半开态，模拟这次探测请求本身发起了但从未回报结果（例如调用方断开连接）
    assert.doesNotThrow(() => assertCircuitAvailable('stuck-provider', { resetTimeoutMs: 0 }))
    assert.strictEqual(getCircuitStates()[0].state, 'half-open')
    // 探测还很新鲜时，其余请求应继续被拒绝
    assert.throws(() => assertCircuitAvailable('stuck-provider', { probeStaleMs: 60_000 }), /probing recovery/)
    // 探测过期（probeStaleMs=0）后，下一次请求应被允许作为新的探测
    assert.doesNotThrow(() => assertCircuitAvailable('stuck-provider', { probeStaleMs: 0 }))
    recordCircuitResult('stuck-provider', { status: 200 })
    assert.strictEqual(getCircuitStates()[0].state, 'closed')
    resetCircuits()
  })

  it('returns retry metadata while a half-open recovery probe is active', () => {
    resetCircuits()
    recordCircuitResult('retry-metadata-provider', { status: 503, failureThreshold: 1 })
    assert.doesNotThrow(() => assertCircuitAvailable('retry-metadata-provider', { resetTimeoutMs: 0 }))
    let recoveryError
    try {
      assertCircuitAvailable('retry-metadata-provider', { probeStaleMs: 60_000 })
    } catch (error) {
      recoveryError = error
    }
    assert.match(recoveryError?.message || '', /probing recovery/)
    assert.strictEqual(recoveryError?.status, 503)
    assert.strictEqual(recoveryError?.statusCode, 503)
    assert.strictEqual(recoveryError?.retryable, true)
    assert.ok(recoveryError?.retryAfterMs > 0)
    resetCircuits()
  })

  it('bounds half-open probes without shortening ordinary requests', async () => {
    const delayedResponse = delayMs => async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response('{}', { status: 200 })),
          delayMs
        )
        const abort = () => {
          clearTimeout(timer)
          reject(signal.reason || new Error('aborted'))
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })

    resetCircuits()
    recordCircuitResult('probe-timeout', { status: 503, failureThreshold: 1 })
    const startedAt = Date.now()
    await assert.rejects(
      fetchWithRetry(delayedResponse(5_000), 'https://example.test', {
        circuitKey: 'probe-timeout',
        circuitResetTimeoutMs: 0,
        circuitProbeTimeoutMs: 20,
        attemptTimeoutMs: 5_000
      }, 1),
      /timed out after 20 ms/
    )
    assert.ok(Date.now() - startedAt < 1_000)
    assert.strictEqual(getCircuitStates()[0].state, 'open')
    assert.strictEqual(getCircuitStates()[0].halfOpenProbeActive, false)

    resetCircuits()
    const normal = await fetchWithRetry(
      delayedResponse(40),
      'https://example.test',
      {
        circuitKey: 'normal-request',
        circuitProbeTimeoutMs: 10,
        attemptTimeoutMs: 200
      },
      1
    )
    assert.strictEqual(normal.status, 200)
    resetCircuits()
  })

  it('maps circuit recovery to HTTP 503 with Retry-After', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [{
      id: 'circuit-http-account',
      label: 'Circuit HTTP Test',
      account_id: 'upstream-circuit-http',
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      expires_at: Date.now() + 60 * 60_000,
      routing_enabled: true,
      status: 'active'
    }]
    resetCircuits()
    recordCircuitResult('chatgpt-sub:circuit-http-account', {
      status: 503,
      failureThreshold: 1
    })
    const server = createServer({
      fetchImpl: async () => assert.fail('open circuit must reject before fetch')
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const { port } = server.address()
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          input: 'circuit status test',
          stream: true
        })
      })
      assert.strictEqual(response.status, 503)
      assert.ok(Number(response.headers.get('retry-after')) >= 1)
      const body = await response.json()
      assert.strictEqual(body.error.type, 'upstream_recovering')
      assert.strictEqual(body.error.retryable, true)
    } finally {
      await new Promise(resolve => server.close(resolve))
      proxyConfig.chatgptAccounts = originalAccounts
      resetCircuits()
    }
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

  it('所有账号冷却时不会选择账号', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'cool-a', status: 'cooldown', cooldown_until: Date.now() + 60_000, routing_enabled: true },
      { id: 'cool-b', status: 'cooldown', cooldown_until: Date.now() + 120_000, routing_enabled: true }
    ]
    try {
      assert.strictEqual(pickActiveAccount(), null)
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('并发持续占满时队列按配置超时并清理票据', async () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [{ id: 'busy-timeout', status: 'active', routing_enabled: true }]
    resetAccountRequestCounts()
    try {
      assert.strictEqual(reserveAccountRequest('busy-timeout', 'busy-1'), true)
      assert.strictEqual(reserveAccountRequest('busy-timeout', 'busy-2'), true)
      assert.strictEqual(reserveAccountRequest('busy-timeout', 'busy-3'), true)
      const account = await acquireActiveAccountWithRetry(
        { aborted: false, headers: {}, requestId: 'queue-timeout-test' },
        'gpt-test',
        null,
        'queue-timeout-session',
        async () => {},
        { retryMs: 1, retryCount: 1 }
      )
      assert.strictEqual(account, null)
      assert.strictEqual(getRouteDecisions(1)[0].outcome, 'queue_timeout')
    } finally {
      resetAccountRequestCounts()
      proxyConfig.chatgptAccounts = original
    }
  })

  it('429 会切换账号且单请求最多请求两个账号', async () => {
    const original = proxyConfig.chatgptAccounts
    const accounts = [
      { id: 'rate-a', account_id: 'up-a', access_token: 'a', status: 'active' },
      { id: 'rate-b', account_id: 'up-b', access_token: 'b', status: 'active' },
      { id: 'rate-c', account_id: 'up-c', access_token: 'c', status: 'active' }
    ]
    proxyConfig.chatgptAccounts = accounts
    const queue = [...accounts]
    let fetchCalls = 0
    const cooled = []
    const released = []
    try {
      const request = Object.assign(new EventEmitter(), {
        headers: {},
        requestId: 'rate-matrix',
        accountLeaseId: 'lease-rate',
        clientAbortSignal: new AbortController().signal
      })
      const result = await sendWithAccountRotation(
        request,
        async () => {},
        '{}',
        { model: 'gpt-test', tryResponsesLite: false },
        {
          acquireAccount: async () => queue.shift() || null,
          ensureToken: async () => {},
          fetchRetry: async () => {
            fetchCalls++
            return new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 })
          },
          markCooldown: async id => cooled.push(id),
          releaseAccount: id => released.push(id)
        }
      )
      assert.strictEqual(fetchCalls, 2)
      assert.strictEqual(result.attempts, 2)
      assert.strictEqual(result.upstream.status, 429)
      assert.deepStrictEqual(cooled, ['rate-a', 'rate-b'])
      assert.deepStrictEqual(released, ['rate-a', 'rate-b'])
    } finally {
      proxyConfig.chatgptAccounts = original
      resetStats()
    }
  })

  it('网络错误和 Token 刷新失败都会轮换两个账号并释放租约', async () => {
    const original = proxyConfig.chatgptAccounts
    const accounts = [
      { id: 'failure-a', account_id: 'up-a', access_token: 'a', status: 'active' },
      { id: 'failure-b', account_id: 'up-b', access_token: 'b', status: 'active' }
    ]
    proxyConfig.chatgptAccounts = accounts
    try {
      for (const failure of ['network', 'token']) {
        const queue = [...accounts]
        const released = []
        let attempts = 0
        await assert.rejects(
          sendWithAccountRotation(
            Object.assign(new EventEmitter(), {
              headers: {},
              requestId: `${failure}-matrix`,
              accountLeaseId: `lease-${failure}`,
              clientAbortSignal: new AbortController().signal
            }),
            async () => {},
            '{}',
            { model: 'gpt-test', tryResponsesLite: false },
            {
              acquireAccount: async () => queue.shift() || null,
              ensureToken: async () => {
                if (failure === 'token') {
                  const error = new Error('refresh token rejected')
                  error.code = 'TOKEN_REFRESH_PERMANENT'
                  error.retryable = false
                  throw error
                }
              },
              fetchRetry: async () => {
                attempts++
                throw new Error('network disconnected')
              },
              releaseAccount: id => released.push(id)
            }
          ),
          error => {
            assert.strictEqual(error.accountAttempts, 2)
            assert.strictEqual(error.accountPoolExhausted, true)
            return true
          }
        )
        assert.strictEqual(failure === 'network' ? attempts : 0, failure === 'network' ? 2 : 0)
        assert.deepStrictEqual(released, ['failure-a', 'failure-b'])
      }
    } finally {
      proxyConfig.chatgptAccounts = original
      resetStats()
    }
  })

  it('两次账号失败后返回包含账号分类和最后错误的可诊断 503', async () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'stored', routing_enabled: false },
      { id: 'auth', routing_enabled: true, status: 'auth_error' },
      { id: 'cool', routing_enabled: true, status: 'cooldown', cooldown_until: Date.now() + 60_000 },
      { id: 'reserve', routing_enabled: true, status: 'active', usage: { primary: { remaining_percent: 10 } } },
      { id: 'busy', routing_enabled: true, status: 'active' }
    ]
    resetAccountRequestCounts()
    reserveAccountRequest('busy', 'busy-a')
    reserveAccountRequest('busy', 'busy-b')
    reserveAccountRequest('busy', 'busy-c')
    const req = Object.assign(new EventEmitter(), {
      headers: {},
      requestId: 'diagnostic-503',
      clientAbortSignal: new AbortController().signal
    })
    const response = {
      status: null,
      body: '',
      writeHead(status) { this.status = status },
      write() {},
      end(value = '') { this.body += value }
    }
    try {
      await handleChatGptSub(req, response, { model: 'gpt-test' }, { model: 'gpt-test' }, {
        sendWithRotation: async () => {
          const error = new Error('second account network failure')
          error.accountAttempts = 2
          error.accountPoolExhausted = true
          throw error
        }
      })
      const payload = JSON.parse(response.body)
      assert.strictEqual(response.status, 503)
      assert.strictEqual(payload.error.type, 'account_pool_attempts_exhausted')
      assert.strictEqual(payload.error.details.account_attempts, 2)
      assert.strictEqual(payload.error.details.stored_only, 1)
      assert.strictEqual(payload.error.details.auth_error, 1)
      assert.strictEqual(payload.error.details.cooling, 1)
      assert.strictEqual(payload.error.details.below_reserve, 1)
      assert.strictEqual(payload.error.details.busy, 1)
      assert.match(payload.error.details.last_error, /second account/)
      assert.strictEqual(payload.error.guide.status, 503)
    } finally {
      resetAccountRequestCounts()
      proxyConfig.chatgptAccounts = original
    }
  })

  it('上游流在客户端取消时仍释放已占用的账号租约', async () => {
    const original = proxyConfig.chatgptAccounts
    const account = { id: 'cancel-account', account_id: 'upstream', status: 'active', routing_enabled: true }
    proxyConfig.chatgptAccounts = [account]
    resetAccountRequestCounts()
    reserveAccountRequest(account.id, 'cancel-lease')
    const req = Object.assign(new EventEmitter(), {
      headers: {},
      requestId: 'cancel-release',
      accountLeaseId: 'cancel-lease',
      clientAbortSignal: new AbortController().signal
    })
    const response = {
      writeHead() {},
      write() {},
      end() {}
    }
    const abortedUpstream = new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('Client disconnected'))
      }
    }), { status: 200 })
    try {
      await assert.rejects(
        handleChatGptSub(req, response, { model: 'gpt-test' }, { model: 'gpt-test' }, {
          sendWithRotation: async () => ({
            upstream: abortedUpstream,
            account,
            attempts: 1,
            queueWaitMs: 0,
            queuePosition: 1
          })
        }),
        /Client disconnected/
      )
      assert.strictEqual(accountActiveRequestCount(account.id), 0)
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
  it('临时账号在有效期内可用，到期后不尝试 Refresh Token 并标记失效', async () => {
    const original = proxyConfig.chatgptAccounts
    const temporary = {
      id: 'temporary-lifecycle',
      account_id: 'temporary-upstream',
      access_token: 'temporary-access',
      refresh_token: null,
      credential_mode: 'temporary_access',
      credential_compatibility: 'codex_subscription',
      expires_at: Date.now() + 60_000,
      status: 'active',
      routing_enabled: true
    }
    proxyConfig.chatgptAccounts = [temporary]
    let fetchCalls = 0
    try {
      assert.equal(accountCredentialLifecycle(temporary).routable, true)
      assert.equal(
        await ensureFreshToken(temporary, async () => {
          fetchCalls++
          throw new Error('should not fetch')
        }),
        temporary
      )
      assert.equal(fetchCalls, 0)

      temporary.expires_at = Date.now() - 1
      await assert.rejects(
        ensureFreshToken(temporary, async () => {
          fetchCalls++
          throw new Error('should not fetch')
        }),
        error => error.code === 'TOKEN_TEMPORARY_ACCESS_EXPIRED' && error.retryable === false
      )
      assert.equal(fetchCalls, 0)
      assert.equal(temporary.status, 'auth_error')
      assert.equal(pickActiveAccount(), null)
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

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

  it('用量接口在未到期 Token 返回 401 时强制刷新并重试一次', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const originalActive = proxyConfig.activeChatgptAccountId
    const originalUrl = proxyConfig.chatgptResponsesUrl
    const account = {
      id: 'usage-auth-retry',
      account_id: 'upstream-usage-auth-retry',
      access_token: 'stale-access',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 3_600_000,
      status: 'active',
      routing_enabled: true
    }
    proxyConfig.chatgptAccounts = [account]
    proxyConfig.activeChatgptAccountId = null
    proxyConfig.chatgptResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    const authorizations = []
    let refreshCalls = 0
    const fetchImpl = async (url, options = {}) => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        refreshCalls++
        return new Response(JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).endsWith('/backend-api/wham/usage')) {
        authorizations.push(options.headers.authorization)
        if (options.headers.authorization === 'Bearer stale-access') {
          return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18_000 }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      assert.fail(`unexpected URL: ${url}`)
    }

    try {
      await refreshAccountUsage(account, fetchImpl)
      const saved = proxyConfig.chatgptAccounts.find(item => item.id === account.id)
      assert.strictEqual(refreshCalls, 1)
      assert.deepStrictEqual(authorizations, ['Bearer stale-access', 'Bearer fresh-access'])
      assert.strictEqual(saved.access_token, 'fresh-access')
      assert.strictEqual(saved.refresh_token, 'fresh-refresh')
      assert.strictEqual(saved.status, 'active')
      assert.strictEqual(saved.usage.primary.remaining_percent, 75)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
      proxyConfig.activeChatgptAccountId = originalActive
      proxyConfig.chatgptResponsesUrl = originalUrl
    }
  })

  it('重置次数接口同样会在 401 后刷新 Token 并重试', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const originalActive = proxyConfig.activeChatgptAccountId
    const originalUrl = proxyConfig.chatgptResponsesUrl
    const account = {
      id: 'reset-credits-auth-retry',
      account_id: 'upstream-reset-credits-auth-retry',
      access_token: 'stale-reset-access',
      refresh_token: 'reset-refresh-token',
      expires_at: Date.now() + 3_600_000,
      status: 'active',
      routing_enabled: true
    }
    proxyConfig.chatgptAccounts = [account]
    proxyConfig.activeChatgptAccountId = null
    proxyConfig.chatgptResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    const authorizations = []
    let refreshCalls = 0
    const fetchImpl = async (url, options = {}) => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        refreshCalls++
        return new Response(JSON.stringify({
          access_token: 'fresh-reset-access',
          refresh_token: 'fresh-reset-refresh'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).endsWith('/backend-api/wham/rate-limit-reset-credits')) {
        authorizations.push(options.headers.authorization)
        if (options.headers.authorization === 'Bearer stale-reset-access') {
          return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          reset_credits: {
            available_count: 2,
            total_earned_count: 3,
            credits: []
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      assert.fail(`unexpected URL: ${url}`)
    }

    try {
      const credits = await refreshAccountResetCredits(account, fetchImpl)
      const saved = proxyConfig.chatgptAccounts.find(item => item.id === account.id)
      assert.strictEqual(refreshCalls, 1)
      assert.deepStrictEqual(authorizations, ['Bearer stale-reset-access', 'Bearer fresh-reset-access'])
      assert.strictEqual(saved.access_token, 'fresh-reset-access')
      assert.strictEqual(credits.available_count, 2)
      assert.strictEqual(saved.reset_credits.available_count, 2)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
      proxyConfig.activeChatgptAccountId = originalActive
      proxyConfig.chatgptResponsesUrl = originalUrl
    }
  })

  it('401 后 Refresh Token 也失效时将账号标记为 auth_error', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const originalActive = proxyConfig.activeChatgptAccountId
    const originalUrl = proxyConfig.chatgptResponsesUrl
    const account = {
      id: 'usage-refresh-relogin',
      account_id: 'upstream-usage-refresh-relogin',
      access_token: 'revoked-access',
      refresh_token: 'revoked-refresh',
      expires_at: Date.now() + 3_600_000,
      status: 'active',
      routing_enabled: true
    }
    proxyConfig.chatgptAccounts = [account]
    proxyConfig.activeChatgptAccountId = null
    proxyConfig.chatgptResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    let usageCalls = 0
    let refreshCalls = 0
    const fetchImpl = async url => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        refreshCalls++
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token is invalid or revoked'
        }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).endsWith('/backend-api/wham/usage')) {
        usageCalls++
        return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      }
      assert.fail(`unexpected URL: ${url}`)
    }

    try {
      await assert.rejects(
        refreshAccountUsage(account, fetchImpl),
        error => error.code === 'TOKEN_REFRESH_RELOGIN_REQUIRED' && error.retryable === false
      )
      const saved = proxyConfig.chatgptAccounts.find(item => item.id === account.id)
      assert.strictEqual(usageCalls, 1)
      assert.strictEqual(refreshCalls, 1)
      assert.strictEqual(saved.status, 'auth_error')
      assert.strictEqual(saved.auth_error.type, 'relogin_required')
      assert.strictEqual(saved.auth_error.status, 401)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
      proxyConfig.activeChatgptAccountId = originalActive
      proxyConfig.chatgptResponsesUrl = originalUrl
    }
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
