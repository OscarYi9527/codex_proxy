import { getCredentialProtectionStatus, listAccountBackups, listConfigSnapshots } from '../config.js'
import { getStats, resetStats } from '../stats.js'
import { readJson, sendJson } from '../server-utils.js'
import { getAccountRuntimeDiagnostics } from '../chatgpt-accounts.js'
import { getAccountQueueDiagnostics } from '../routes/chatgpt-sub.js'
import { getRouteDecisions } from '../route-decisions.js'
import { getProviderHealth } from '../provider-health.js'
import { getRuntimeDeploymentInfo } from '../runtime-info.js'
import { buildAutomaticDiagnosis } from '../diagnostics.js'
import { getPriceCatalog, updatePriceCatalog } from '../pricing.js'
import { getCostReport } from '../cost-governance.js'

export function handleStatsGet(req, res) {
  return sendJson(res, 200, getStats())
}

export function handleStatsDelete(req, res) {
  return sendJson(res, 200, resetStats())
}

export function handleDiagnosticsGet(req, res) {
  const deployment = getRuntimeDeploymentInfo()
  return sendJson(res, 200, {
    generated_at: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      node: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      tls_verification: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
    },
    credential_protection: getCredentialProtectionStatus(),
    deployment,
    queue: getAccountQueueDiagnostics(),
    accounts: getAccountRuntimeDiagnostics(),
    recent_route_decisions: getRouteDecisions(30),
    provider_health: getProviderHealth(),
    automatic_diagnosis: buildAutomaticDiagnosis(),
    config_snapshots: listConfigSnapshots(),
    account_backups: listAccountBackups()
  })
}

export function handleAutomaticDiagnosisGet(req, res, query = {}) {
  return sendJson(res, 200, buildAutomaticDiagnosis({
    status: query.status,
    errorType: query.error_type || query.type,
    provider: query.provider,
    model: query.model
  }))
}

export function handlePriceCatalogGet(req, res) {
  return sendJson(res, 200, getPriceCatalog())
}

export async function handlePriceCatalogPut(req, res) {
  try {
    const body = await readJson(req)
    return sendJson(res, 200, {
      catalog: updatePriceCatalog(body),
      message: '模型价格目录已更新；后续完成请求将按新价格估算'
    })
  } catch (error) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  }
}

export function handleCostReportGet(req, res) {
  return sendJson(res, 200, getCostReport())
}

export function handleConfigSnapshotsGet(req, res) {
  return sendJson(res, 200, { snapshots: listConfigSnapshots() })
}
