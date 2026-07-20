import './helpers/test-storage-root.js'
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCodexModel, isChatGptSubModel, isOpenAIApiModel, isRelayModel, parseRelayModel, buildModelsResponse, getThreadId } from '../src/models.js'
import { recordUsage, recordAccountOutcome, recordOperationalEvent, getStats, resetStats, saveStats, statsDayKey } from '../src/stats.js'
import { ACCOUNT_ROUTING_STRATEGIES, accountActiveRequestCount, accountConcurrencyLimit, accountPolicyState, accountPoolTierState, accountRemainingPercent, accountUsageIsFresh, calculateUsageForecast, checkChatgptAccountStatus, classifyAccountCheckFailure, consumeAccountResetCredit, cooldownMsFromResponseText, enforceDisposableAccountLifecycle, ensureFreshToken, extractResetCredits, extractUsageFromBody, extractUsageFromHeaders, mergeAccountUsageWindows, normalizeAccountPoolTier, normalizeAccountRoutingStrategy, noteAccountAdaptiveOutcome, noteAccountSuccess, pickActiveAccount, refreshAccountQuotaSnapshot, refreshAccountResetCredits, refreshAccountUsage, releaseAccountRequest, renewAccountRequestLease, reserveAccountRequest, resetAccountRequestCounts, resetAccountStickiness } from '../src/chatgpt-accounts.js'
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

  it('官方仅返回一周窗口时按时长放入周额度而不是 5 小时额度', () => {
    const usage = extractUsageFromBody({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 604800,
          reset_after_seconds: 557596
        },
        secondary_window: {
          used_percent: 0,
          limit_window_seconds: 0,
          reset_after_seconds: 0
        }
      }
    })

    assert.strictEqual(usage.primary, null)
    assert.strictEqual(usage.secondary.window_minutes, 10080)
    assert.strictEqual(usage.secondary.remaining_percent, 75)
    assert.strictEqual(usage.complete_windows, true)
  })

  it('完整用量响应会清除已取消窗口，响应头增量更新仍保留其他窗口', () => {
    const previous = {
      primary: { window_minutes: 300, remaining_percent: 80 },
      secondary: { window_minutes: 10080, remaining_percent: 70 }
    }
    const weeklyOnly = mergeAccountUsageWindows(previous, {
      primary: null,
      secondary: { window_minutes: 10080, remaining_percent: 60 },
      complete_windows: true
    })
    assert.strictEqual(weeklyOnly.primary, null)
    assert.strictEqual(weeklyOnly.secondary.remaining_percent, 60)

    const partialHeaders = mergeAccountUsageWindows(previous, {
      primary: { window_minutes: 300, remaining_percent: 75 },
      secondary: null,
      complete_windows: false
    })
    assert.strictEqual(partialHeaders.primary.remaining_percent, 75)
    assert.strictEqual(partialHeaders.secondary.remaining_percent, 70)
  })
})

describe('Codex 额度重置', () => {
  it('兼容重置次数接口字段并排除已使用或已过期次数', () => {
    const reset = extractResetCredits({
      reset_credits: {
        totalCount: 4,
        items: [
          { id: 'credit-live', expiresAt: '2099-01-01T00:00:00Z', status: 'available' },
          { redeemRequestId: 'credit-used', expires_at: '2099-01-01T00:00:00Z', status: 'used' },
          { redeem_request_id: 'credit-expired', expires_at: '2000-01-01T00:00:00Z' }
        ]
      }
    })

    assert.strictEqual(reset.available_count, 1)
    assert.strictEqual(reset.total_earned_count, 4)
    assert.strictEqual(reset.credits[0].redeem_request_id, 'credit-live')
    assert.strictEqual(reset.credits[0].expires_at, '2099-01-01T00:00:00.000Z')
  })

  it('额度重置必须同时确认账号名称和账号 ID', async () => {
    const account = {
      id: 'acct-local',
      label: '工作账号',
      account_id: 'upstream-account',
      access_token: 'access',
      expires_at: Date.now() + 60_000
    }
    const neverFetch = async () => {
      assert.fail('确认失败时不应请求上游')
    }

    await assert.rejects(
      consumeAccountResetCredit(account, {
        confirmed: true,
        confirmedTargetAccount: true,
        confirmedCreditConsumption: true,
        confirmedAccountLabel: '其他账号',
        confirmedAccountId: account.account_id
      }, neverFetch),
      error => error.code === 'ACCOUNT_LABEL_CONFIRMATION_MISMATCH'
    )
    await assert.rejects(
      consumeAccountResetCredit(account, {
        confirmed: true,
        confirmedTargetAccount: true,
        confirmedCreditConsumption: true,
        confirmedAccountLabel: account.label,
        confirmedAccountId: 'wrong-account'
      }, neverFetch),
      error => error.code === 'ACCOUNT_CONFIRMATION_MISMATCH'
    )
  })

  it('缺少任一风险确认时不会请求上游', async () => {
    const account = {
      id: 'acct-local',
      label: '工作账号',
      account_id: 'upstream-account'
    }
    const neverFetch = async () => {
      assert.fail('风险确认不完整时不应请求上游')
    }
    const baseConfirmation = {
      confirmed: true,
      confirmedTargetAccount: true,
      confirmedCreditConsumption: true,
      confirmedAccountLabel: account.label,
      confirmedAccountId: account.account_id
    }

    await assert.rejects(
      consumeAccountResetCredit(account, {
        ...baseConfirmation,
        confirmedTargetAccount: false
      }, neverFetch),
      error => error.code === 'TARGET_ACCOUNT_CONFIRMATION_REQUIRED'
    )
    await assert.rejects(
      consumeAccountResetCredit(account, {
        ...baseConfirmation,
        confirmedCreditConsumption: false
      }, neverFetch),
      error => error.code === 'RESET_IMPACT_CONFIRMATION_REQUIRED'
    )
  })

  it('完成全部确认后才进入最新次数查询和重置流程', async () => {
    const account = {
      id: 'acct-local',
      label: '工作账号',
      account_id: 'upstream-account',
      access_token: 'access',
      expires_at: Date.now() + 60_000
    }
    const calls = []
    const mockFetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method })
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          reset_credits: {
            available_count: 1,
            credits: [{
              redeem_request_id: 'credit-live',
              expires_at: '2099-01-01T00:00:00Z',
              status: 'available'
            }]
          }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('upstream unavailable', { status: 502 })
    }

    await assert.rejects(
      consumeAccountResetCredit(account, {
        confirmed: true,
        confirmedTargetAccount: true,
        confirmedCreditConsumption: true,
        confirmedAccountLabel: account.label,
        confirmedAccountId: account.account_id
      }, mockFetch),
      /Codex 额度重置失败/
    )
    assert.strictEqual(calls.length, 2)
    assert.match(calls[0].url, /rate-limit-reset-credits$/)
    assert.match(calls[1].url, /rate-limit-reset-credits\/consume$/)
    assert.strictEqual(calls[1].method, 'POST')
  })

  it('管理配置不会暴露凭据或一次性兑换标识', () => {
    const config = publicProxyConfig({
      chatgptAccounts: [{
        id: 'acct-local',
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: 'id',
        reset_credits: {
          available_count: 1,
          total_earned_count: 2,
          expires_at: ['2099-01-01T00:00:00.000Z'],
          updated_at: '2026-01-01T00:00:00.000Z',
          credits: [{ redeem_request_id: 'one-time-secret' }]
        }
      }]
    })
    const account = config.chatgptAccounts[0]

    assert.strictEqual(account.access_token, undefined)
    assert.strictEqual(account.refresh_token, undefined)
    assert.strictEqual(account.reset_credits.available_count, 1)
    assert.strictEqual(account.reset_credits.credits, undefined)
    assert.ok(!JSON.stringify(config).includes('one-time-secret'))
  })

  it('手动同步用量时会同时更新重置次数，避免两个时间戳不同步', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const originalUrl = proxyConfig.chatgptResponsesUrl
    const account = {
      id: 'quota-snapshot',
      account_id: 'upstream-quota-snapshot',
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Date.now() + 60_000,
      status: 'active',
      routing_enabled: true
    }
    proxyConfig.chatgptAccounts = [account]
    proxyConfig.chatgptResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    const calls = []
    const mockFetch = async url => {
      calls.push(String(url))
      if (String(url).endsWith('/backend-api/wham/usage')) {
        return new Response(JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 30, limit_window_seconds: 604_800 }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).endsWith('/backend-api/wham/rate-limit-reset-credits')) {
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
      const result = await refreshAccountQuotaSnapshot(account, mockFetch)
      const saved = proxyConfig.chatgptAccounts[0]
      assert.strictEqual(result.usage_synced, true)
      assert.strictEqual(result.reset_credits_synced, true)
      assert.strictEqual(saved.usage.primary.remaining_percent, 80)
      assert.strictEqual(saved.reset_credits.available_count, 2)
      assert.ok(saved.usage_updated_at)
      assert.ok(saved.reset_credits.updated_at)
      assert.strictEqual(calls.length, 2)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
      proxyConfig.chatgptResponsesUrl = originalUrl
    }
  })
})

describe('ChatGPT 账号状态检查', () => {
  it('只在上游明确停用账号时判断疑似封禁，并区分额度与临时网络故障', () => {
    const account = {
      credential_mode: 'refreshable',
      credential_compatibility: 'codex_subscription'
    }
    const banned = classifyAccountCheckFailure({
      status: 403,
      upstreamCode: 'account_deactivated',
      upstreamMessage: 'account has been deactivated'
    }, account)
    assert.strictEqual(banned.state, 'banned')
    assert.strictEqual(banned.remaining_percent, null)
    assert.strictEqual(classifyAccountCheckFailure({
      status: 429,
      upstreamCode: 'insufficient_quota',
      upstreamMessage: 'usage limit reached'
    }, account).state, 'quota_exhausted')
    assert.strictEqual(classifyAccountCheckFailure(
      new TypeError('fetch failed: socket timeout'),
      account
    ).state, 'temporary_unavailable')
    assert.strictEqual(classifyAccountCheckFailure({
      status: 403,
      upstreamCode: 'permission_denied'
    }, account).state, 'permission_denied')
  })

  it('全账号检查同步用量和次数，并把零额度归类为额度不足', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const originalUrl = proxyConfig.chatgptResponsesUrl
    const account = {
      id: 'status-check-quota',
      account_id: 'upstream-status-check',
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Date.now() + 60_000,
      credential_mode: 'refreshable',
      credential_compatibility: 'codex_subscription',
      status: 'active',
      routing_enabled: true,
      pool_tier: 'stable'
    }
    proxyConfig.chatgptAccounts = [account]
    proxyConfig.chatgptResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    const mockFetch = async url => {
      if (String(url).endsWith('/backend-api/wham/usage')) {
        return new Response(JSON.stringify({
          rate_limit: {
            secondary_window: { used_percent: 100, limit_window_seconds: 604_800 }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        reset_credits: { available_count: 1, credits: [] }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    try {
      const check = await checkChatgptAccountStatus(account, mockFetch)
      const saved = proxyConfig.chatgptAccounts[0]
      assert.strictEqual(check.state, 'quota_exhausted')
      assert.strictEqual(check.usage_synced, true)
      assert.strictEqual(check.reset_credits_synced, true)
      assert.strictEqual(saved.health_check.state, 'quota_exhausted')
      assert.strictEqual(saved.reset_credits.available_count, 1)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
      proxyConfig.chatgptResponsesUrl = originalUrl
    }
  })

  it('403 停用响应会保存明确原因并停止该账号参与选择', async () => {
    const originalAccounts = proxyConfig.chatgptAccounts
    const originalUrl = proxyConfig.chatgptResponsesUrl
    const account = {
      id: 'status-check-banned',
      account_id: 'upstream-status-check-banned',
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Date.now() + 60_000,
      credential_mode: 'refreshable',
      credential_compatibility: 'codex_subscription',
      status: 'active',
      routing_enabled: true
    }
    proxyConfig.chatgptAccounts = [account]
    proxyConfig.chatgptResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
    const mockFetch = async () => new Response(JSON.stringify({
      error: { code: 'account_deactivated', message: 'account has been deactivated' }
    }), { status: 403, headers: { 'content-type': 'application/json' } })

    try {
      const check = await checkChatgptAccountStatus(account, mockFetch)
      const saved = proxyConfig.chatgptAccounts[0]
      assert.strictEqual(check.state, 'banned')
      assert.strictEqual(saved.status, 'auth_error')
      assert.strictEqual(saved.auth_error.type, 'health_check_banned')
      assert.strictEqual(pickActiveAccount(), null)
    } finally {
      proxyConfig.chatgptAccounts = originalAccounts
      proxyConfig.chatgptResponsesUrl = originalUrl
    }
  })
})

describe('额度感知和会话粘性账号选择', () => {
  it('新增账号按凭据来源自动分级，也接受登录时明确分类', () => {
    assert.strictEqual(normalizeAccountPoolTier(null, 'refreshable'), 'stable')
    assert.strictEqual(normalizeAccountPoolTier(null, 'temporary_access'), 'disposable')
    assert.strictEqual(normalizeAccountPoolTier('disposable', 'refreshable'), 'disposable')
    assert.strictEqual(normalizeAccountPoolTier('stable', 'temporary_access'), 'stable')
  })

  it('优先消耗日抛池并把稳定订阅池作为保险回退', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      {
        id: 'stable-insurance',
        pool_tier: 'stable',
        status: 'active',
        routing_enabled: true,
        usage: { secondary: { remaining_percent: 80 } }
      },
      {
        id: 'disposable-first',
        pool_tier: 'disposable',
        status: 'active',
        routing_enabled: true,
        usage: { secondary: { remaining_percent: 5 } }
      }
    ]
    try {
      assert.strictEqual(accountPolicyState(proxyConfig.chatgptAccounts[0]).reserve, 10)
      assert.strictEqual(accountPolicyState(proxyConfig.chatgptAccounts[1]).reserve, 0)
      assert.strictEqual(pickActiveAccount()?.id, 'disposable-first')
      proxyConfig.chatgptAccounts[1].usage.secondary.remaining_percent = 0
      assert.strictEqual(pickActiveAccount()?.id, 'stable-insurance')
    } finally {
      proxyConfig.chatgptAccounts = original
    }
  })

  it('日抛号用到 0 后等待 7 天，未重置则自动弃用', () => {
    const now = Date.parse('2026-07-20T00:00:00Z')
    const account = {
      id: 'disposable-expiry',
      pool_tier: 'disposable',
      status: 'active',
      routing_enabled: true,
      usage: { secondary: { remaining_percent: 0 } }
    }
    assert.strictEqual(enforceDisposableAccountLifecycle(account, now), true)
    let state = accountPoolTierState(account, now)
    assert.strictEqual(state.exhausted, true)
    assert.strictEqual(state.discarded, false)
    assert.strictEqual(state.discard_deadline_at, '2026-07-27T00:00:00.000Z')
    assert.strictEqual(enforceDisposableAccountLifecycle(account, now + 6 * 24 * 60 * 60 * 1000), false)
    assert.strictEqual(enforceDisposableAccountLifecycle(account, now + 7 * 24 * 60 * 60 * 1000 + 1), true)
    state = accountPoolTierState(account, now + 7 * 24 * 60 * 60 * 1000 + 1)
    assert.strictEqual(state.discarded, true)
    assert.strictEqual(account.status, 'discarded')
    assert.strictEqual(account.routing_enabled, false)
    assert.strictEqual(account.discard_reason, 'quota_not_reset_within_7_days')
  })

  it('日抛号在 7 天内恢复额度时取消弃号倒计时', () => {
    const now = Date.parse('2026-07-20T00:00:00Z')
    const account = {
      id: 'disposable-reset',
      pool_tier: 'disposable',
      status: 'active',
      routing_enabled: true,
      usage: { secondary: { remaining_percent: 0 } }
    }
    enforceDisposableAccountLifecycle(account, now)
    account.usage.secondary.remaining_percent = 100
    assert.strictEqual(enforceDisposableAccountLifecycle(account, now + 24 * 60 * 60 * 1000), true)
    const state = accountPoolTierState(account, now + 24 * 60 * 60 * 1000)
    assert.strictEqual(state.exhausted, false)
    assert.strictEqual(state.discard_deadline_at, null)
    assert.strictEqual(account.disposable_last_reset_at, '2026-07-21T00:00:00.000Z')
  })

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

  it('每账号安全余量、每日上限和紧急继续策略独立生效', () => {
    const original = proxyConfig.chatgptAccounts
    resetStats()
    proxyConfig.chatgptAccounts = [{
      id: 'policy-account',
      status: 'active',
      routing_enabled: true,
      low_quota_threshold: 20,
      daily_request_limit: 1,
      usage: { primary: { remaining_percent: 15 } }
    }]
    try {
      assert.strictEqual(pickActiveAccount(null, { lowQuotaThreshold: 10 }), null)
      recordAccountOutcome('policy-account', { status: 200, latencyMs: 10 })
      const limited = accountPolicyState(proxyConfig.chatgptAccounts[0])
      assert.strictEqual(limited.request_limited, true)
      proxyConfig.chatgptAccounts[0].emergency_continue_until = new Date(Date.now() + 60_000).toISOString()
      assert.strictEqual(pickActiveAccount(null, { lowQuotaThreshold: 10 }).id, 'policy-account')
    } finally {
      resetStats()
      proxyConfig.chatgptAccounts = original
    }
  })

  it('预留账号仅服务匹配的模型或会话并获得优先选择', () => {
    const original = proxyConfig.chatgptAccounts
    proxyConfig.chatgptAccounts = [
      { id: 'general', status: 'active', routing_enabled: true, usage: { primary: { remaining_percent: 90 } } },
      {
        id: 'reserved',
        status: 'active',
        routing_enabled: true,
        reserved_models: ['gpt-important'],
        reserved_session_ids: ['vip-thread'],
        usage: { primary: { remaining_percent: 30 } }
      }
    ]
    try {
      assert.strictEqual(pickActiveAccount(null, { model: 'gpt-normal' }).id, 'general')
      assert.strictEqual(pickActiveAccount(null, { model: 'gpt-important' }).id, 'reserved')
      assert.strictEqual(pickActiveAccount(null, { model: 'gpt-normal', sessionKey: 'vip-thread' }).id, 'reserved')
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
