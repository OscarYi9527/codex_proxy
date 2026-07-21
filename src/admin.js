import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyConfig, reloadProxyConfig, saveProxyConfig, CONFIG_FILE, addRelay, deleteRelay } from './config.js'
import { readJson, sendJson } from './server-utils.js'
import { syncRelayModels } from './sync-models.js'
import { publicProxyConfig } from './admin/shared.js'
import { safeErrorText } from './logger.js'

export { publicProxyConfig } from './admin/shared.js'
export { summarizeCodexLaunchFailure, resolveCodexLaunch, getChatgptLoginPreflight, isLocalAdminRequest, parseDeviceAuthOutput, privateBrowserArgs, officialLoginUrlWithHint, findPrivateBrowser, findDuplicateAccount, handleChatgptLoginStart, handleChatgptLoginStatus, handleChatgptLoginPreflight, handleChatgptLoginCancel } from './admin/login.js'
export { handleChatgptAccountAdd, handleChatgptAccountsImport, handleChatgptAccountImportCurrent, handleChatgptAccountDelete, handleChatgptAccountsReorder, handleChatgptAccountRename, handleChatgptAccountRouting, handleChatgptAccountRefreshUsage, handleChatgptAccountsRefreshAll, handleChatgptAccountsCheckAll, handleChatgptAccountCheckTasksList, handleChatgptAccountCheckTaskGet, handleChatgptAccountCheckTaskCancel, handleChatgptAccountCheckTaskResume, handleChatgptAccountHealthEventsGet, handleChatgptAccountSwitch, handleCodexRestart, handleChatgptAccountResetCreditsGet, handleChatgptAccountsRefreshResetCreditsAll, handleChatgptAccountResetQuota } from './admin/accounts.js'
export { handleStatsGet, handleStatsDelete, handleDiagnosticsGet, handleAutomaticDiagnosisGet, handlePriceCatalogGet, handlePriceCatalogPut, handleCostReportGet, handleConfigSnapshotsGet } from './admin/diagnostics.js'
export { handleRuntimeInfoGet, handleDeployUpdate, handleAccountBackupsGet, handleAccountBackupRestore, handleConfigRollback, handleRuntimeRepair, handleProviderHealthReset, handleProxyRestart } from './admin/operations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8')
const adminUiBehaviorsJs = fs.readFileSync(path.join(__dirname, 'admin_ui_behaviors.cjs'), 'utf8')
const adminModuleJs = ['accounts.js', 'tutorial.js', 'analytics.js', 'settings.js']
  .map(name => fs.readFileSync(path.join(__dirname, 'admin_modules', name), 'utf8'))
  .join('\n;\n')
const adminAppJs = fs.readFileSync(path.join(__dirname, 'admin_app.js'), 'utf8')

export function getAdminHtml() {
  return adminHtml
}

export function getAdminAppJs() {
  return `${adminUiBehaviorsJs}\n;\n${adminModuleJs}\n;\n${adminAppJs}`
}

export function handleAdminConfigGet(req, res) {
  const masked = publicProxyConfig(proxyConfig)
  return sendJson(res, 200, { config: masked, configFile: CONFIG_FILE })
}

export async function handleAdminConfigPut(req, res) {
  try {
    const body = await readJson(req)
    // Masked values returned by the admin API are display-only. Keep the
    // original secret when a form submits that placeholder unchanged.
    for (const key of ['deepseekApiKey', 'openaiApiKey']) {
      if (typeof body[key] === 'string' && body[key].includes('*')) {
        body[key] = proxyConfig[key]
      }
    }
    const newCfg = saveProxyConfig(body, { snapshot: true, reason: 'admin-config' })
    reloadProxyConfig()
    const masked = publicProxyConfig(newCfg)
    return sendJson(res, 200, { config: masked, reloaded: true })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: safeErrorText(error) } })
  }
}

export async function handleRelayAdd(req, res, body) {
  try {
    if (!body.id || !body.name || !body.base_url) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'ID、名称和 API 地址为必填项' } })
    }
    const existingRelay = (proxyConfig.relays || []).find(relay => relay.id === body.id)
    const apiKey = typeof body.api_key === 'string' && body.api_key.includes('*')
      ? (existingRelay?.api_key || '')
      : (body.api_key || '')
    const newCfg = addRelay({
      id: body.id,
      name: body.name,
      base_url: body.base_url.replace(/\/+$/, ''),
      api_key: apiKey,
      models: body.models || ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
    })
    const masked = publicProxyConfig(newCfg)
    syncRelayModels()
    return sendJson(res, 200, { config: masked, message: '中转站已添加，已同步到 codex-models.json' })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: safeErrorText(error) } })
  }
}

export async function handleRelayDelete(req, res, relayId) {
  try {
    const newCfg = deleteRelay(relayId)
    syncRelayModels()
    const masked = publicProxyConfig(newCfg)
    return sendJson(res, 200, { config: masked, message: '中转站已删除，已同步到 codex-models.json' })
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: safeErrorText(error) } })
  }
}
