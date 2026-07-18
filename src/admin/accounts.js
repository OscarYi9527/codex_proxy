import fs from 'node:fs'
import path from 'node:path'
import { proxyConfig, setActiveChatgptAccount, reorderChatgptAccounts, renameChatgptAccount, setChatgptAccountRouting } from '../config.js'
import { addChatgptAccount, consumeAccountResetCredit, deleteChatgptAccount, ensureFreshToken, parseAuthJson, refreshAccountResetCredits, refreshAccountUsage } from '../chatgpt-accounts.js'
import { sendJson } from '../server-utils.js'
import { chinaFetch } from '../china-fetch.js'
import { getCodexAuthFile, isLocalAdminRequest, killLocalCodexProcesses } from './login.js'
import { publicProxyConfig } from './shared.js'
import { parseChatgptAccountImport } from '../account-import.js'

export async function handleChatgptAccountAdd(req, res, body) {
  try {
    if (!body.auth_json) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'auth.json 内容为必填项' } })
    }
    const newCfg = addChatgptAccount(body.auth_json, body.label, {
      routingEnabled: body.routingEnabled === true
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
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
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
    const existingIds = new Set(
      (proxyConfig.chatgptAccounts || []).map(account => account.account_id)
    )
    const imported = []
    const skipped = []
    const routingEnabled = body?.routingEnabled === true
    for (const record of records) {
      if (existingIds.has(record.accountId)) {
        skipped.push({ accountId: record.accountId, reason: 'duplicate' })
        continue
      }
      const label = records.length === 1 && String(body?.label || '').trim()
        ? String(body.label).trim().slice(0, 80)
        : record.label
      addChatgptAccount(record.authJson, label, { routingEnabled })
      existingIds.add(record.accountId)
      imported.push({
        accountId: record.accountId,
        label,
        sourceFormat: record.sourceFormat
      })
    }
    return sendJson(res, 200, {
      config: publicProxyConfig(proxyConfig),
      result: {
        imported: imported.length,
        skipped: skipped.length,
        formats: [...new Set(imported.map(item => item.sourceFormat))]
      },
      message: imported.length
        ? `已导入 ${imported.length} 个账号${skipped.length ? `，跳过 ${skipped.length} 个重复账号` : ''}；默认${routingEnabled ? '已启用' : '仅保存'}`
        : `未导入新账号，已跳过 ${skipped.length} 个重复账号`
    })
  } catch (error) {
    return sendJson(res, 400, {
      error: { type: 'invalid_request_error', message: error.message }
    })
  }
}

export async function handleChatgptAccountImportCurrent(req, res) {
  try {
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
    const newCfg = addChatgptAccount(raw, '当前 Codex 账号')
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
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  }
}

export async function handleChatgptAccountDelete(req, res, accountId) {
  try {
    const newCfg = deleteChatgptAccount(accountId)
    const masked = publicProxyConfig({ ...proxyConfig, chatgptAccounts: newCfg.chatgptAccounts })
    return sendJson(res, 200, { config: masked, message: '账号已删除' })
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
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
      error: { type: 'invalid_request_error', message: error.message }
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
      error: { type: 'invalid_request_error', message: error.message }
    })
  }
}

export function handleChatgptAccountRouting(req, res, accountId, body) {
  try {
    const newCfg = setChatgptAccountRouting(accountId, {
      weight: body?.weight,
      enabled: body?.enabled,
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
      error: { type: 'invalid_request_error', message: error.message }
    })
  }
}

export async function handleChatgptAccountRefreshUsage(req, res, accountId) {
  try {
    const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
    if (!account) {
      return sendJson(res, 404, { error: { type: 'not_found_error', message: '账号不存在' } })
    }
    await refreshAccountUsage(account, chinaFetch(fetch))
    const masked = publicProxyConfig(proxyConfig)
    return sendJson(res, 200, { config: masked, message: '用量已刷新' })
  } catch (error) {
    return sendJson(res, 502, { error: { type: 'server_error', message: error.message } })
  }
}

export async function handleChatgptAccountsRefreshAll(req, res) {
  const accounts = proxyConfig.chatgptAccounts || []
  const errors = []
  let cursor = 0
  const worker = async () => {
    while (cursor < accounts.length) {
      const account = accounts[cursor++]
      try {
        await refreshAccountUsage(account, chinaFetch(fetch))
      } catch (error) {
        errors.push(`${account.label || account.id}: ${error.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, accounts.length) }, worker))
  const masked = publicProxyConfig(proxyConfig)
  return sendJson(res, 200, {
    config: masked,
    message: errors.length ? `已刷新，部分账号失败：${errors.join('; ')}` : '全部账号用量已刷新'
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
    return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
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
  try {
    const account = (proxyConfig.chatgptAccounts || []).find(a => a.id === accountId)
    if (!account) {
      return sendJson(res, 404, { error: { type: 'not_found_error', message: '账号不存在' } })
    }
    await refreshAccountResetCredits(account, chinaFetch(fetch))
    return sendJson(res, 200, {
      config: publicProxyConfig(proxyConfig),
      message: 'Codex 重置次数已查询'
    })
  } catch (error) {
    return sendJson(res, 502, { error: { type: 'server_error', message: error.message } })
  }
}

export async function handleChatgptAccountsRefreshResetCreditsAll(req, res) {
  const accounts = proxyConfig.chatgptAccounts || []
  const errors = []
  let cursor = 0
  const worker = async () => {
    while (cursor < accounts.length) {
      const account = accounts[cursor++]
      try {
        await refreshAccountResetCredits(account, chinaFetch(fetch))
      } catch (error) {
        errors.push(`${account.label || account.id}: ${error.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, accounts.length) }, worker))
  return sendJson(res, 200, {
    config: publicProxyConfig(proxyConfig),
    message: errors.length ? `查询完成，部分账号失败：${errors.join('; ')}` : '全部账号的 Codex 重置次数已查询'
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
      error: { type: status === 502 ? 'server_error' : 'invalid_request_error', message: error.message }
    })
  }
}
