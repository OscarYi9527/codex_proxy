import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { proxyConfig, reloadProxyConfig, saveProxyConfig, CONFIG_FILE, addRelay, deleteRelay } from './config.js'
import { getStats, resetStats } from './stats.js'
import { sendJson, readJson } from './server-utils.js'
import { syncRelayModels } from './sync-models.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8')
const adminAppJs = fs.readFileSync(path.join(__dirname, 'admin_app.js'), 'utf8')

export function getAdminHtml() {
  return adminHtml
}

export function getAdminAppJs() {
  return adminAppJs
}

export function handleAdminConfigGet(req, res) {
  const masked = { ...proxyConfig }
  for (const k of ['deepseekApiKey', 'openaiApiKey']) {
    if (masked[k] && masked[k].length > 4) {
      masked[k] = masked[k].slice(0, 4) + '*'.repeat(masked[k].length - 4)
    }
  }
  if (masked.relays) {
    masked.relays = masked.relays.map(r => ({
      ...r,
      api_key: r.api_key && r.api_key.length > 6 ? r.api_key.slice(0, 6) + '***' : r.api_key
    }))
  }
  return sendJson(res, 200, { config: masked, configFile: CONFIG_FILE })
}

export async function handleAdminConfigPut(req, res) {
  try {
    const body = await readJson(req)
    const newCfg = saveProxyConfig(body)
    reloadProxyConfig()
    const masked = { ...newCfg }
    for (const k of ['deepseekApiKey', 'openaiApiKey']) {
      if (masked[k] && masked[k].length > 4) {
        masked[k] = masked[k].slice(0, 4) + '*'.repeat(masked[k].length - 4)
      }
    }
    return sendJson(res, 200, { config: masked, reloaded: true })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  }
}

export async function handleRelayAdd(req, res, body) {
  try {
    if (!body.id || !body.name || !body.base_url) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'ID、名称和 API 地址为必填项' } })
    }
    const newCfg = addRelay({
      id: body.id,
      name: body.name,
      base_url: body.base_url.replace(/\/+$/, ''),
      api_key: body.api_key || '',
      models: body.models || ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
    })
    const masked = { ...newCfg }
    for (const k of ['deepseekApiKey', 'openaiApiKey']) {
      if (masked[k] && masked[k].length > 4) {
        masked[k] = masked[k].slice(0, 4) + '*'.repeat(masked[k].length - 4)
      }
    }
    if (masked.relays) {
      masked.relays = masked.relays.map(r => ({
        ...r, api_key: r.api_key && r.api_key.length > 6 ? r.api_key.slice(0, 6) + '***' : r.api_key
      }))
    }
    syncRelayModels()
    return sendJson(res, 200, { config: masked, message: '中转站已添加，已同步到 codex-models.json' })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  }
}

export async function handleRelayDelete(req, res, relayId) {
  try {
    const newCfg = deleteRelay(relayId)
    syncRelayModels()
    const masked = { ...newCfg }
    for (const k of ['deepseekApiKey', 'openaiApiKey']) {
      if (masked[k] && masked[k].length > 4) {
        masked[k] = masked[k].slice(0, 4) + '*'.repeat(masked[k].length - 4)
      }
    }
    return sendJson(res, 200, { config: masked, message: '中转站已删除，已同步到 codex-models.json' })
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
  }
}

export function handleStatsGet(req, res) {
  return sendJson(res, 200, getStats())
}

export function handleStatsDelete(req, res) {
  return sendJson(res, 200, resetStats())
}
