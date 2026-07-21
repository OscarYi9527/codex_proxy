import fs from 'node:fs'
import path from 'node:path'
import { proxyConfig, setActiveChatgptAccount, reorderChatgptAccounts, renameChatgptAccount, setChatgptAccountRouting } from '../config.js'
import { accountCredentialLifecycle, accountPoolTierState, addChatgptAccount, consumeAccountResetCredit, deleteChatgptAccount, ensureFreshToken, parseAuthJson, refreshAccountQuotaSnapshot, refreshAccountResetCredits, refreshAccountUsage, withAccountStore } from '../chatgpt-accounts.js'
import { sendJson } from '../server-utils.js'
import { chinaFetch } from '../china-fetch.js'
import { getCodexAuthFile, isLocalAdminRequest, killLocalCodexProcesses } from './login.js'
import { publicProxyConfig } from './shared.js'
import { parseChatgptAccountImport } from '../account-import.js'
import { accountCheckTaskManager } from '../account-check-tasks.js'
import { JsonAccountStore, listAccountHealthEvents } from '../account-store.js'
import { safeErrorText } from '../logger.js'

async function runBatchedAccountOperation(accounts, operation, {
  batchSize = 20,
  concurrency = 2
} = {}) {
  for (let offset = 0; offset < accounts.length; offset += batchSize) {
    const batch = accounts.slice(offset, offset + batchSize)
    const store = new JsonAccountStore()
    let cursor = 0
    await withAccountStore(store, async () => {
      const worker = async () => {
        while (cursor < batch.length) {
          const account = batch[cursor++]
          await operation(account)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, batch.length) }, worker)
      )
    })
    await store.flush()
  }
}

export async function handleChatgptAccountAdd(req, res, body) {
  try {
    if (!body.auth_json) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'auth.json 内容为必填项' } })
    }
    const newCfg = addChatgptAccount(body.auth_json, body.label, {
      routingEnabled: body.routingEnabled === true,
      poolTier: body.poolTier
    })
    const incoming = parseAuthJson(body.auth_json)
    const account = newCfg.chatgptAccounts.find(item => item.account_id === incoming.account_id)
    let message = '账号已添加，额度已自动同步'
    try {
      if (account) await refreshAccountUsage(account, chinaFetch(fetch))
    } catch {
      message = '账号已添加，首次额度同步失败，可点击刷新按钮重试'
    }
    return sendJson(res, 200, { config: publicProxyConfig(proxyConfig), message })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: safeErrorText(error) } })
  }
}

export function handleChatgptAccountsImport(req, res, body) {
  try {
    if (!isLocalAdminRequest(req)) {
      return sendJson(res, 403, {
        error: { type: 'permission_error', message: '账号文件只能从本机管理后台导入' }
      })
    }
    const records = parseChatgptAccountImport(body?.content || body?.auth_json || '')
    const existingById = new Map(
      (proxyConfig.chatgptAccounts || []).map(account => [account.account_id, account])
    )
    const imported = []
    const skipped = []
    const rejected = []
    const routingEnabled = body?.routingEnabled === true
    const poolTierInput = String(body?.poolTier || '').trim().toLowerCase()
    const requestedPoolTier = ['stable', 'disposable'].includes(poolTierInput)
      ? poolTierInput
      : null
    for (const record of records) {
      const existing = existingById.get(record.accountId)
      const upgradesTemporary = existing &&
        (existing.credential_mode === 'temporary_access' || !existing.refresh_token) &&
        record.credentialMode === 'refreshable'
      if (existing && !upgradesTemporary) {
        skipped.push({ accountId: record.accountId, reason: 'duplicate' })
        continue
      }
      const label = records.length === 1 && String(body?.label || '').trim()
        ? String(body.label).trim().slice(0, 80)
        : record.label
      try {
        const poolTier = requestedPoolTier || existing?.pool_tier ||
          (record.credentialMode === 'temporary_access' ? 'disposable' : 'stable')
        addChatgptAccount(record.authJson, label, {
          routingEnabled,
          allowAccessOnly: record.credentialMode === 'temporary_access',
          sourceFormat: record.sourceFormat,
          email: record.email,
          planType: record.planType,
          poolTier
        })
      } catch (error) {
        rejected.push({
          accountId: record.accountId,
          label,
          reason: safeErrorText(error)
        })
        continue
      }
      const savedAccount = (proxyConfig.chatgptAccounts || []).find(
        account => account.account_id === record.accountId
      )
      existingById.set(record.accountId, savedAccount)
      imported.push({
        accountId: record.accountId,
        label,
        sourceFormat: record.sourceFormat,
        credentialMode: record.credentialMode,
        credentialCompatibility: savedAccount?.credential_compatibility || null,
        poolTier: savedAccount?.pool_tier || null,
        upgraded: Boolean(upgradesTemporary)
      })
    }
    const temporary = imported.filter(item => item.credentialMode === 'temporary_access').length
    const refreshable = imported.length - temporary
    const upgraded = imported.filter(item => item.upgraded).length
    const incompatible = imported.filter(
      item => item.credentialMode === 'temporary_access' &&
        item.credentialCompatibility !== 'codex_subscription'
    ).length
    const stable = imported.filter(item => item.poolTier === 'stable').length
    const disposable = imported.filter(item => item.poolTier === 'disposable').length
    return sendJson(res, 200, {
      config: publicProxyConfig(proxyConfig),
      result: {
        imported: imported.length,
        skipped: skipped.length,
        rejected: rejected.length,
        temporary,
        refreshable,
        upgraded,
        incompatible,
        stable,
        disposable,
        formats: [...new Set(imported.map(item => item.sourceFormat))],
        credential_modes: [...new Set(imported.map(item => item.credentialMode))],
        rejections: rejected
      },
      message: imported.length
        ? `已导入 ${imported.length} 个账号（稳定池 ${stable}，日抛池 ${disposable}；临时 ${temporary}，可续约 ${refreshable}${incompatible ? `，不兼容 ${incompatible}` : ''}${upgraded ? `，其中升级 ${upgraded}` : ''}）${skipped.length ? `，跳过 ${skipped.length} 个重复账号` : ''}${rejected.length ? `，拒绝 ${rejected.length} 个无效账号` : ''}；${incompatible ? '不兼容账号已强制设为仅保存' : `默认${routingEnabled ? '已启用' : '仅保存'}`}`
        : rejected.length
          ? `未导入新账号；拒绝 ${rejected.length} 个无效账号：${rejected[0].reason}${skipped.length ? `，另跳过 ${skipped.length} 个重复账号` : ''}`
          : `未导入新账号，已跳过 ${skipped.length} 个重复账号`
    })
  } catch (error) {
    return sendJson(res, 400, {
      error: { type: 'invalid_request_error', message: safeErrorText(error) }
    })
  }
}

export async function handleChatgptAccountImportCurrent(req, res) {
  try {
    const requestedPoolTier = new URL(req.url || '/', 'http://localhost').searchParams.get('poolTier')
    const authFile = getCodexAuthFile()
    if (!fs.existsSync(authFile)) {
      return sendJson(res, 404, {
        error: {
          type: 'not_found_error',
          message: `未找到当前 Codex 登录文件：${authFile}`
        }
      })
    }
    const raw = fs.readFileSync(authFile, 'utf8')
    const incoming = parseAuthJson(raw)
    const newCfg = addChatgptAccount(raw, '当前 Codex 账号', {
      poolTier: requestedPoolTier
    })
    const account = newCfg.chatgptAccounts.find(item => item.account_id === incoming.account_id)
    let usageMessage = '，额度已自动同步'
    try {
      if (account) await refreshAccountUsage(account, chinaFetch(fetch))
    } catch {
      usageMessage = '，首次额度同步失败，可在账号池点击刷新重试'
    }
    const masked = publicProxyConfig(proxyConfig)
    return sendJson(res, 200, {
      config: masked,
      message: `已从当前 Codex CLI 快捷导入账号${usageMessage}`
    })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: safeErrorText(error) } })
  }
}

export async function handleChatgptAccountDelete(req, res, accountId) {
  try {
    const newCfg = deleteChatgptAccount(accountId)
    const masked = publicProxyConfig({ ...proxyConfig, chatgptAccounts: newCfg.chatgptAccounts })
    return sendJson(res, 200, { config: masked, message: '账号已删除' })
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: safeErrorText(error) } })
  }
}

export function handleChatgptAccountsReorder(req, res, body) {
  try {
    const newCfg = reorderChatgptAccounts(body?.accountIds)
    return sendJson(res, 200, {
      config: publicProxyConfig(newCfg),
      message: '账号优先级已更新'
    })
  } catch (error) {
    return sendJson(res, 400, {
      error: { type: 'invalid_request_error', message: safeErrorText(error) }
    })
  }
}

export function handleChatgptAccountRename(req, res, accountId, body) {
  try {
    const newCfg = renameChatgptAccount(accountId, body?.label)
    return sendJson(res, 200, {
      config: publicProxyConfig(newCfg),
      message: '账号名称已更新'
    })
  } catch (error) {
    return sendJson(res, error.message === 'Account not found' ? 404 : 400, {
      error: { type: 'invalid_request_error', message: safeErrorText(error) }
    })
  }
}

export function handleChatgptAccountRouting(req, res, accountId, body) {
  try {
    const account = (proxyConfig.chatgptAccounts || []).find(item => item.id === accountId)
    if (!account) {
      return sendJson(res, 404, {
        error: { type: 'not_found_error', message: '账号不存在' }
      })
    }
    if (body?.enabled === true) {
      const poolTier = accountPoolTierState(account)
      if (poolTier.discarded) {
        return sendJson(res, 400, {
          error: {
            type: 'invalid_request_error',
            message: '该日抛账号已因 7 天未恢复额度而弃用；请先改为稳定池后再启用'
          }
        })
      }
      const credential = accountCredentialLifecycle(account)
      if (!credential.routable) {
        const message = credential.compatible
          ? '临时 Access Token 已到期或即将到期，不能启用路由；请完成官方登录'
          : '该 Token 不是 Codex 官方 OAuth 客户端签发，不能启用订阅路由；请完成官方登录'
        return sendJson(res, 400, {
          error: { type: 'invalid_request_error', message }
        })
      }
    }
    const newCfg = setChatgptAccountRouting(accountId, {
      weight: body?.weight,
      enabled: body?.enabled,
      poolTier: body?.poolTier,
      lowQuotaThreshold: body?.lowQuotaThreshold,
      dailyRequestLimit: body?.dailyRequestLimit,
      dailyTokenLimit: body?.dailyTokenLimit,
      reservedModels: body?.reservedModels,
      reservedSessionIds: body?.reservedSessionIds,
      emergencyContinueMinutes: body?.emergencyContinueMinutes,
      confirmedEmergencyRisk: body?.confirmedEmergencyRisk
    })
    return sendJson(res, 200, {
      config: publicProxyConfig(newCfg),
      message: body?.emergencyContinueMinutes > 0
        ? '已临时允许紧急继续使用；到期后自动恢复额度与每日上限保护'
        : body?.enabled === undefined
        ? '账号路由策略已更新'
        : (body.enabled ? '账号已启用路由' : '账号已设为仅保存')
    })
  } catch (error) {
    return sendJson(res, error.message === 'Account not found' ? 404 : 400, {
      error: { type: 'invalid_request_error', message: safeErrorText(error) }
    })
  }
}

export async function handleChatgptAccountRefreshUsage(req, res, accountId) {
  try {
    const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
    if (!account) {
      return sendJson(res, 404, { error: { type: 'not_found_error', message: '账号不存在' } })
    }
    const snapshot = await refreshAccountQuotaSnapshot(account, chinaFetch(fetch))
    const masked = publicProxyConfig(proxyConfig)
    if (
      !snapshot.usage_synced &&
      !snapshot.reset_credits_synced &&
      snapshot.usage_status === 'failed' &&
      snapshot.reset_credit_status === 'failed'
    ) {
      throw snapshot.usage_error || snapshot.reset_credits_error || new Error('账号额度与重置次数同步失败')
    }
    return sendJson(res, 200, {
      config: masked,
      result: {
        usage_synced: snapshot.usage_synced,
        reset_credits_synced: snapshot.reset_credits_synced,
        usage_status: snapshot.usage_status,
        reset_credit_status: snapshot.reset_credit_status,
        has_failures: snapshot.usage_status === 'failed' ||
          snapshot.reset_credit_status === 'failed',
        warnings: snapshot.warnings
      },
      message: snapshot.warnings.length
        ? `同步完成，但部分数据失败：${snapshot.warnings.join('；')}`
        : '账号用量和重置次数已同步'
    })
  } catch (error) {
    return sendJson(res, 502, { error: { type: 'server_error', message: safeErrorText(error) } })
  }
}

export async function handleChatgptAccountsRefreshAll(req, res) {
  const accounts = proxyConfig.chatgptAccounts || []
  const errors = []
  const notices = []
  let usageSynced = 0
  let resetCreditsSynced = 0
  const usageStatuses = {}
  const resetCreditStatuses = {}
  try {
    await runBatchedAccountOperation(accounts, async account => {
      try {
        const snapshot = await refreshAccountQuotaSnapshot(account, chinaFetch(fetch))
        if (snapshot.usage_synced) usageSynced++
        if (snapshot.reset_credits_synced) resetCreditsSynced++
        usageStatuses[snapshot.usage_status] = (usageStatuses[snapshot.usage_status] || 0) + 1
        resetCreditStatuses[snapshot.reset_credit_status] =
          (resetCreditStatuses[snapshot.reset_credit_status] || 0) + 1
        if (snapshot.warnings.length) {
          const target = snapshot.usage_status === 'failed' ||
            snapshot.reset_credit_status === 'failed'
            ? errors
            : notices
          target.push(`${account.label || account.id}: ${snapshot.warnings.join('；')}`)
        }
      } catch (error) {
        errors.push(`${account.label || account.id}: ${safeErrorText(error)}`)
      }
    })
  } catch (error) {
    return sendJson(res, 500, {
      error: { type: 'server_error', message: `批量账号状态写入失败：${safeErrorText(error)}` }
    })
  }
  const masked = publicProxyConfig(proxyConfig)
  return sendJson(res, 200, {
    config: masked,
    result: {
      total: accounts.length,
      usage_synced: usageSynced,
      reset_credits_synced: resetCreditsSynced,
      usage_statuses: usageStatuses,
      reset_credit_statuses: resetCreditStatuses,
      notices,
      errors
    },
    message: errors.length
      ? `同步完成：用量 ${usageSynced}/${accounts.length}，重置次数 ${resetCreditsSynced}/${accounts.length}；${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `；另有 ${errors.length - 3} 个账号失败` : ''}`
      : notices.length
        ? `同步完成；${notices.slice(0, 3).join('; ')}${notices.length > 3 ? `；另有 ${notices.length - 3} 个账号存在不支持项` : ''}`
      : '全部账号用量和重置次数已同步'
  })
}

export function handleChatgptAccountsCheckAll(
  req,
  res,
  taskManager = accountCheckTaskManager
) {
  const started = taskManager.start()
  return sendJson(res, 202, {
    task: started.task,
    result: started.task,
    created: started.created,
    message: started.created
      ? `账号检查任务已创建，共 ${started.task.total} 个账号`
      : '已有账号检查任务正在执行，已返回当前进度'
  })
}

export function handleChatgptAccountCheckTasksList(
  req,
  res,
  taskManager = accountCheckTaskManager
) {
  return sendJson(res, 200, { tasks: taskManager.list() })
}

export function handleChatgptAccountCheckTaskGet(
  req,
  res,
  taskId,
  taskManager = accountCheckTaskManager
) {
  const task = taskManager.get(taskId)
  if (!task) {
    return sendJson(res, 404, {
      error: { type: 'not_found_error', message: '账号检查任务不存在' }
    })
  }
  const terminal = ['completed', 'cancelled', 'failed', 'interrupted'].includes(task.status)
  return sendJson(res, 200, {
    task,
    result: task,
    ...(terminal ? { config: publicProxyConfig(proxyConfig) } : {}),
    message: task.status === 'completed'
      ? `状态检查完成：基础正常 ${task.healthy}，需要关注 ${task.issues}`
      : `状态检查进度：${task.processed}/${task.total}`
  })
}

export function handleChatgptAccountCheckTaskCancel(
  req,
  res,
  taskId,
  taskManager = accountCheckTaskManager
) {
  const task = taskManager.cancel(taskId)
  if (!task) {
    return sendJson(res, 404, {
      error: { type: 'not_found_error', message: '账号检查任务不存在' }
    })
  }
  return sendJson(res, 202, {
    task,
    result: task,
    message: task.status === 'cancelled'
      ? '账号检查任务已取消'
      : '已请求取消；当前在途账号完成后停止'
  })
}

export function handleChatgptAccountCheckTaskResume(
  req,
  res,
  taskId,
  taskManager = accountCheckTaskManager
) {
  try {
    const task = taskManager.resume(taskId)
    if (!task) {
      return sendJson(res, 404, {
        error: { type: 'not_found_error', message: '账号检查任务不存在' }
      })
    }
    return sendJson(res, 202, {
      task,
      result: task,
      message: '账号检查任务已从最后一个提交批次恢复'
    })
  } catch (error) {
    return sendJson(res, 409, {
      error: { type: 'conflict_error', message: safeErrorText(error) }
    })
  }
}

export function handleChatgptAccountHealthEventsGet(req, res, accountId) {
  const account = (proxyConfig.chatgptAccounts || []).find(item => item.id === accountId)
  if (!account) {
    return sendJson(res, 404, {
      error: { type: 'not_found_error', message: '账号不存在' }
    })
  }
  const limit = new URL(req.url || '/', 'http://localhost').searchParams.get('limit')
  return sendJson(res, 200, {
    account: {
      id: account.id,
      label: account.label || account.email || account.account_id || account.id
    },
    events: listAccountHealthEvents(account.id, { limit })
  })
}

export async function handleChatgptAccountSwitch(req, res, accountId) {
  try {
    if (!isLocalAdminRequest(req)) {
      return sendJson(res, 403, { error: { type: 'permission_error', message: '切换账号只能从本机管理后台发起' } })
    }
    const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
    if (!account) {
      return sendJson(res, 404, { error: { type: 'not_found_error', message: '账号不存在' } })
    }
    if (account.credential_mode === 'temporary_access' || !account.refresh_token) {
      return sendJson(res, 400, {
        error: {
          type: 'invalid_request_error',
          message: '临时账号不能切换为本机 Codex 登录；可在账号池中直接参与路由，或先完成官方登录'
        }
      })
    }
    await ensureFreshToken(account, chinaFetch(fetch))

    // Deliberate one-click user action (unlike the login-flow race this
    // isolated-CODEX_HOME approach elsewhere avoids) - overwrite the real
    // shared auth.json so the local Codex CLI/app/VSCode extension picks up
    // this account on their next request.
    const authFile = getCodexAuthFile()
    fs.mkdirSync(path.dirname(authFile), { recursive: true })
    fs.writeFileSync(authFile, JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: account.id_token || null,
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        account_id: account.account_id
      },
      last_refresh: account.last_refresh || new Date().toISOString()
    }, null, 2))

    setActiveChatgptAccount(accountId)
    const restart = await killLocalCodexProcesses()
    const masked = publicProxyConfig(proxyConfig)
    return sendJson(res, 200, {
      config: masked,
      message: `已切换到「${account.label || account.account_id}」，${restart.message}`
    })
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: safeErrorText(error) } })
  }
}

export async function handleCodexRestart(req, res) {
  if (!isLocalAdminRequest(req)) {
    return sendJson(res, 403, { error: { type: 'permission_error', message: '重启操作只能从本机管理后台发起' } })
  }
  const restart = await killLocalCodexProcesses()
  return sendJson(res, 200, { message: restart.message })
}

export async function handleChatgptAccountResetCreditsGet(req, res, accountId) {
  const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
  if (!account) {
    return sendJson(res, 404, { error: { type: 'not_found_error', message: '账号不存在' } })
  }
  try {
    await refreshAccountResetCredits(account, chinaFetch(fetch))
    return sendJson(res, 200, {
      config: publicProxyConfig(proxyConfig),
      result: { status: 'synced' },
      message: 'Codex 重置次数已查询'
    })
  } catch (error) {
    const latest = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId) || account
    if (latest.reset_credit_status === 'unsupported') {
      return sendJson(res, 200, {
        config: publicProxyConfig(proxyConfig),
        result: { status: 'unsupported' },
        message: latest.reset_credit_error || '当前套餐不支持 Codex 重置次数'
      })
    }
    return sendJson(res, 502, { error: { type: 'server_error', message: safeErrorText(error) } })
  }
}

export async function handleChatgptAccountsRefreshResetCreditsAll(req, res) {
  const accounts = proxyConfig.chatgptAccounts || []
  const errors = []
  const notices = []
  const statuses = {}
  try {
    await runBatchedAccountOperation(accounts, async account => {
      try {
        await refreshAccountResetCredits(account, chinaFetch(fetch))
      } catch (error) {
        const latest = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
        const target = latest.reset_credit_status === 'unsupported' ? notices : errors
        target.push(
          `${account.label || account.id}: ${safeErrorText(latest.reset_credit_error || error)}`
        )
      } finally {
        const latest = (proxyConfig.chatgptAccounts || []).find(item => item.id === account.id) || account
        const status = latest.reset_credit_status || 'stale'
        statuses[status] = (statuses[status] || 0) + 1
      }
    })
  } catch (error) {
    return sendJson(res, 500, {
      error: { type: 'server_error', message: `批量重置次数写入失败：${safeErrorText(error)}` }
    })
  }
  return sendJson(res, 200, {
    config: publicProxyConfig(proxyConfig),
    result: { total: accounts.length, statuses, notices, errors },
    message: errors.length
      ? `查询完成，部分账号失败：${errors.join('; ')}`
      : notices.length
        ? `查询完成；${notices.join('; ')}`
        : '全部账号的 Codex 重置次数已查询'
  })
}

export async function handleChatgptAccountResetQuota(req, res, accountId, body) {
  try {
    const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
    if (!account) {
      return sendJson(res, 404, { error: { type: 'not_found_error', message: '账号不存在' } })
    }
    const result = await consumeAccountResetCredit(account, {
      confirmed: body?.confirmed,
      confirmedTargetAccount: body?.confirmedTargetAccount,
      confirmedCreditConsumption: body?.confirmedCreditConsumption,
      confirmedAccountId: body?.confirmedAccountId,
      confirmedAccountLabel: body?.confirmedAccountLabel
    }, chinaFetch(fetch))
    return sendJson(res, 200, {
      config: publicProxyConfig(proxyConfig),
      message: result.refresh_warnings.length
        ? `额度已重置，但刷新最新数据时遇到问题：${result.refresh_warnings.join('; ')}`
        : 'Codex 额度已重置，最新额度和剩余重置次数已同步'
    })
  } catch (error) {
    const status = ['NO_RESET_CREDITS', 'RESET_IN_PROGRESS'].includes(error.code)
      ? 409
      : [
          'CONFIRMATION_REQUIRED',
          'TARGET_ACCOUNT_CONFIRMATION_REQUIRED',
          'RESET_IMPACT_CONFIRMATION_REQUIRED',
          'ACCOUNT_CONFIRMATION_MISMATCH',
          'ACCOUNT_LABEL_CONFIRMATION_MISMATCH',
          'RESET_CREDIT_INVALID'
        ].includes(error.code)
        ? 400
        : 502
    return sendJson(res, status, {
      error: {
        type: status === 502 ? 'server_error' : 'invalid_request_error',
        message: safeErrorText(error)
      }
    })
  }
}
