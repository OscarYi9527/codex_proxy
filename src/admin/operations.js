import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { listAccountBackups, restoreAccountBackup, restoreConfigSnapshot } from '../config.js'
import { repairAccountRuntimeState } from '../chatgpt-accounts.js'
import { readJson, sendJson } from '../server-utils.js'
import { resetProviderHealth } from '../provider-health.js'
import { getRuntimeDeploymentInfo } from '../runtime-info.js'
import { isLocalAdminRequest } from './login.js'
import { publicProxyConfig } from './shared.js'
import { safeErrorText } from '../logger.js'

export function handleRuntimeInfoGet(req, res) {
  return sendJson(res, 200, getRuntimeDeploymentInfo())
}

export function handleDeployUpdate(req, res) {
  if (!isLocalAdminRequest(req)) {
    return sendJson(res, 403, { error: { type: 'permission_error', message: '部署更新只能从本机管理后台发起' } })
  }
  const deployment = getRuntimeDeploymentInfo()
  if (!deployment.can_deploy) {
    return sendJson(res, 409, {
      error: {
        type: 'deployment_not_available',
        message: deployment.consistency.synchronized
          ? '工作区与安装目录已经一致，无需部署'
          : '无法定位可部署的工作区或安装目录'
      }
    })
  }
  const script = deployment.update_script
  if (!script || !fs.existsSync(script)) {
    return sendJson(res, 503, {
      error: { type: 'service_unavailable', message: '工作区缺少 update-codex-proxy.ps1，无法执行安全部署' }
    })
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const child = spawn(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-SourceDir', deployment.source.path,
      '-InstallDir', deployment.installation.path
    ], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: deployment.source.path
    })
    child.unref()
    return sendJson(res, 202, {
      message: '已启动安全部署：将自动备份、重启、健康检查，失败时自动回滚',
      source: deployment.source.path,
      installation: deployment.installation.path
    })
  } catch (error) {
    return sendJson(res, 500, {
      error: { type: 'server_error', message: `无法启动部署脚本：${safeErrorText(error)}` }
    })
  }
}

export function handleAccountBackupsGet(req, res) {
  return sendJson(res, 200, { backups: listAccountBackups() })
}

export async function handleAccountBackupRestore(req, res) {
  try {
    const body = await readJson(req)
    const restored = restoreAccountBackup(body?.name)
    return sendJson(res, 200, {
      config: publicProxyConfig(restored.config),
      restored: restored.restoredCount,
      message: restored.restoredCount
        ? `已恢复 ${restored.restoredCount} 个缺失账号；现有账号和 Token 未被覆盖`
        : '备份中没有需要恢复的缺失账号，现有账号未发生变化'
    })
  } catch (error) {
    return sendJson(res, 400, {
      error: { type: 'invalid_request_error', message: safeErrorText(error) }
    })
  }
}

export async function handleConfigRollback(req, res) {
  try {
    const body = await readJson(req)
    const restored = restoreConfigSnapshot(body?.name)
    return sendJson(res, 200, {
      config: publicProxyConfig(restored),
      message: '配置已回滚到所选快照'
    })
  } catch (error) {
    return sendJson(res, 400, {
      error: { type: 'invalid_request_error', message: safeErrorText(error) }
    })
  }
}

export function handleRuntimeRepair(req, res) {
  const repaired = repairAccountRuntimeState()
  return sendJson(res, 200, {
    repaired,
    message: repaired ? `已修复 ${repaired} 个异常账号状态` : '未发现需要修复的异常状态'
  })
}

export function handleProviderHealthReset(req, res) {
  return sendJson(res, 200, {
    provider_health: resetProviderHealth(),
    message: 'Provider 健康历史已清空'
  })
}

export function handleProxyRestart(req, res) {
  sendJson(res, 202, { message: '代理将等待正在进行的请求完成后重启' })
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref()
}
