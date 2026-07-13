import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { proxyConfig, reloadProxyConfig, saveProxyConfig, CONFIG_FILE, addRelay, deleteRelay, getCredentialProtectionStatus, setActiveChatgptAccount, reorderChatgptAccounts, renameChatgptAccount, setChatgptAccountRouting, listAccountBackups, listConfigSnapshots, restoreAccountBackup, restoreConfigSnapshot } from './config.js'
import { getStats, resetStats } from './stats.js'
import { sendJson, readJson } from './server-utils.js'
import { syncRelayModels } from './sync-models.js'
import { addChatgptAccount, deleteChatgptAccount, refreshAccountUsage, ensureFreshToken, parseAuthJson, getAccountRuntimeDiagnostics, repairAccountRuntimeState } from './chatgpt-accounts.js'
import { getAccountQueueDiagnostics } from './routes/chatgpt-sub.js'
import { chinaFetch } from './china-fetch.js'
import { getRouteDecisions } from './route-decisions.js'

function maskChatgptAccounts(accounts) {
  if (!accounts) return accounts
  return accounts.map(({ access_token, refresh_token, id_token, ...account }) => account)
}

function publicProxyConfig(config) {
  const masked = { ...config }
  for (const key of ['deepseekApiKey', 'openaiApiKey']) {
    if (masked[key] && masked[key].length > 4) {
      masked[key] = masked[key].slice(0, 4) + '*'.repeat(masked[key].length - 4)
    }
  }
  masked.relays = (masked.relays || []).map(relay => ({
    ...relay,
    api_key: relay.api_key && relay.api_key.length > 6 ? relay.api_key.slice(0, 6) + '***' : relay.api_key
  }))
  masked.chatgptAccounts = maskChatgptAccounts(masked.chatgptAccounts)
  return masked
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8')
const adminAppJs = fs.readFileSync(path.join(__dirname, 'admin_app.js'), 'utf8')
let loginSession = null

function getCodexAuthFile() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'auth.json')
}

function resolveCodexJsPath() {
  const appData = process.env.APPDATA || ''
  return process.env.CODEX_CLI_JS || path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
}

// Best-effort: finds any local process whose command line references the
// resolved codex.js (the CLI, its `login` subprocess, etc) and kills it, so a
// freshly-switched-to account's auth.json is picked up on next Codex invocation.
// Matches on the codex.js path specifically so this can never kill this proxy's
// own server.js process.
function killLocalCodexProcesses() {
  return new Promise(resolve => {
    const codexJs = resolveCodexJsPath()
    if (!fs.existsSync(codexJs)) {
      return resolve({ killed: false, message: '未找到本机 Codex CLI，跳过重启' })
    }
    const escaped = codexJs.replace(/'/g, "''")
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('error', () => resolve({ killed: false, message: '无法启动 PowerShell 执行重启操作' }))
    child.on('exit', () => resolve({ killed: true, message: '已尽力重启本机 Codex 进程' }))
  })
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

export function isLocalAdminRequest(req) {
  const remote = req.socket?.remoteAddress || ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote.endsWith(':127.0.0.1')
  if (!loopback) return false
  try {
    const host = new URL(`http://${req.headers?.host || ''}`).hostname
    if (!isLoopbackHostname(host)) return false
  } catch {
    return false
  }
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return isLoopbackHostname(host)
  } catch {
    return false
  }
}

function publicLoginSession() {
  if (!loginSession) return { status: 'idle' }
  return {
    id: loginSession.id,
    status: loginSession.status,
    message: loginSession.message,
    startedAt: loginSession.startedAt,
    verificationUrl: loginSession.verificationUrl || null,
    userCode: loginSession.userCode || null,
    privateBrowserKind: loginSession.privateBrowserKind || null
  }
}

export function parseDeviceAuthOutput(output) {
  const text = String(output || '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '')
  const urls = [...text.matchAll(/https:\/\/[^\s<>"']+/gi)]
    .map(match => match[0].replace(/[\u0000-\u001f\u007f]/g, '').replace(/[.,;:)]+$/, ''))
  const url = urls.find(value => /device|verify|auth/i.test(value)) || urls.at(-1) || null
  const userCode = text.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b/)?.[0] || null
  return { verificationUrl: url, userCode }
}

export function privateBrowserArgs(kind, url) {
  if (kind === 'chrome') return ['--incognito', '--new-window', url]
  if (kind === 'edge') return ['--inprivate', '--new-window', url]
  if (kind === 'firefox') return ['-private-window', url]
  return null
}

function defaultBrowserKind() {
  if (process.platform !== 'win32') return null
  try {
    const result = spawnSync('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v',
      'ProgId'
    ], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase()
    if (output.includes('chromehtml')) return 'chrome'
    if (output.includes('msedgehtm')) return 'edge'
    if (output.includes('firefoxurl')) return 'firefox'
  } catch {}
  return null
}

function browserCandidates(preferredKind = null) {
  const at = (base, ...parts) => base ? path.join(base, ...parts) : null
  const locations = {
    chrome: [
      at(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      at(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      at(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ],
    edge: [
      at(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      at(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ],
    firefox: [
      at(process.env.PROGRAMFILES, 'Mozilla Firefox', 'firefox.exe'),
      at(process.env['PROGRAMFILES(X86)'], 'Mozilla Firefox', 'firefox.exe')
    ]
  }
  const order = [...new Set([preferredKind, 'chrome', 'edge', 'firefox'].filter(Boolean))]
  return order.flatMap(kind => locations[kind].map(executable => ({ kind, executable })))
}

export function findPrivateBrowser({
  preferredKind = defaultBrowserKind(),
  exists = fs.existsSync
} = {}) {
  return browserCandidates(preferredKind).find(candidate => candidate.executable && exists(candidate.executable)) || null
}

function openPrivateBrowser(url) {
  if (process.platform !== 'win32' || !String(url).startsWith('https://')) return null
  const browser = findPrivateBrowser()
  const args = browser && privateBrowserArgs(browser.kind, url)
  if (!browser || !args) return null
  try {
    const child = spawn(browser.executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
    return browser.kind
  } catch {
    return null
  }
}

function updateDeviceAuthDetails(session, output) {
  const parsed = parseDeviceAuthOutput(output)
  if (parsed.verificationUrl) session.verificationUrl = parsed.verificationUrl
  if (parsed.userCode) session.userCode = parsed.userCode
  if (session.verificationUrl && !session.privateBrowserAttempted) {
    session.privateBrowserAttempted = true
    session.privateBrowserKind = openPrivateBrowser(session.verificationUrl)
  }
  if (session.verificationUrl) {
    const opened = session.privateBrowserKind
      ? `已自动打开 ${session.privateBrowserKind} 私密窗口`
      : '未能自动打开私密窗口，请点击下方按钮手动打开'
    session.message = session.userCode
      ? `${opened}，请输入代码 ${session.userCode}`
      : `${opened}，并选择要新增的账号`
  }
}

export function findDuplicateAccount(accounts, accountId) {
  return (accounts || []).find(account => account.account_id === accountId) || null
}

function writeAppServerMessage(session, message) {
  if (!session.child?.stdin?.writable) return false
  session.child.stdin.write(`${JSON.stringify(message)}\n`)
  return true
}

async function importCompletedLogin(session) {
  if (session.finalizing || loginSession?.id !== session.id) return
  session.finalizing = true
  try {
    for (let attempt = 0; attempt < 30 && !fs.existsSync(session.authFile); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!fs.existsSync(session.authFile)) throw new Error('登录完成，但隔离目录中没有生成 auth.json')
    const raw = fs.readFileSync(session.authFile, 'utf8')
    const incoming = parseAuthJson(raw)
    const duplicate = findDuplicateAccount(proxyConfig.chatgptAccounts, incoming.account_id)
    if (duplicate) {
      throw new Error(
        `登录的是已存在账号「${duplicate.label || duplicate.account_id}」，未覆盖任何账号。请重新开始并在无痕窗口中选择另一个账号。`
      )
    }
    const newCfg = addChatgptAccount(raw, session.label, { routingEnabled: session.routingEnabled })
    const account = newCfg.chatgptAccounts.find(item => item.account_id === incoming.account_id)
    let usageMessage = ''
    try {
      if (account) await refreshAccountUsage(account, chinaFetch(fetch))
      usageMessage = '，额度已同步'
    } catch {
      usageMessage = '，首次额度同步失败，可在账号池点击刷新重试'
    }
    try { session.child?.kill() } catch {}
    finishLoginSession(session, 'success', `官方登录成功，账号已自动加入账号池${usageMessage}`)
  } catch (error) {
    try { session.child?.kill() } catch {}
    finishLoginSession(session, 'error', error.message)
  }
}

function handleAppServerLoginMessage(session, message) {
  if (loginSession?.id !== session.id || session.status !== 'waiting') return
  if (message.id === 1) {
    if (message.error) {
      try { session.child?.kill() } catch {}
      finishLoginSession(session, 'error', message.error.message || 'Codex app-server 初始化失败')
      return
    }
    writeAppServerMessage(session, { method: 'initialized', params: {} })
    writeAppServerMessage(session, {
      method: 'account/login/start',
      id: 2,
      params: { type: 'chatgpt' }
    })
    return
  }
  if (message.id === 2) {
    if (message.error) {
      try { session.child?.kill() } catch {}
      finishLoginSession(session, 'error', message.error.message || '无法启动 ChatGPT 浏览器登录')
      return
    }
    const result = message.result || {}
    if (!result.authUrl || !result.loginId) {
      try { session.child?.kill() } catch {}
      finishLoginSession(session, 'error', 'Codex app-server 没有返回登录地址')
      return
    }
    session.loginId = result.loginId
    session.verificationUrl = result.authUrl
    session.privateBrowserAttempted = true
    session.privateBrowserKind = openPrivateBrowser(result.authUrl)
    session.message = session.privateBrowserKind
      ? `已自动打开 ${session.privateBrowserKind} 私密窗口，请在其中完成 OpenAI 官方登录`
      : '未能自动打开私密窗口，请点击下方按钮并确认使用私密模式'
    return
  }
  if (message.method === 'account/login/completed') {
    const params = message.params || {}
    if (session.loginId && params.loginId !== session.loginId) return
    if (!params.success) {
      try { session.child?.kill() } catch {}
      finishLoginSession(session, 'error', params.error || 'OpenAI 官方登录未完成')
      return
    }
    void importCompletedLogin(session)
  }
}

function cleanupLoginTemp(session) {
  if (!session.tempHome) return
  try { fs.rmSync(session.tempHome, { recursive: true, force: true }) } catch {}
}

function finishLoginSession(session, status, message) {
  if (loginSession?.id !== session.id) return
  cleanupLoginTemp(session)
  session.status = status
  session.message = message
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  session.child = null
}

export function getAdminHtml() {
  return adminHtml
}

export function getAdminAppJs() {
  return adminAppJs
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
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
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
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: error.message } })
  }
}

export async function handleRelayDelete(req, res, relayId) {
  try {
    const newCfg = deleteRelay(relayId)
    syncRelayModels()
    const masked = publicProxyConfig(newCfg)
    return sendJson(res, 200, { config: masked, message: '中转站已删除，已同步到 codex-models.json' })
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
  }
}

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

export async function handleChatgptLoginStart(req, res) {
  try {
    if (!isLocalAdminRequest(req)) {
      return sendJson(res, 403, {
        error: { type: 'permission_error', message: '官方登录只能从本机管理后台发起' }
      })
    }
    if (loginSession?.status === 'waiting') {
      return sendJson(res, 409, {
        error: { type: 'conflict_error', message: '已有一个登录流程正在进行，请先完成或取消' }
      })
    }
    const body = await readJson(req)
    const codexJs = resolveCodexJsPath()
    if (!fs.existsSync(codexJs)) {
      return sendJson(res, 503, {
        error: { type: 'service_unavailable', message: '未找到本机 Codex CLI，请先安装或更新 Codex' }
      })
    }

    // Isolated CODEX_HOME so this login never touches the user's real
    // ~/.codex/auth.json. Refresh tokens are single-use/rotating, so writing
    // to the shared file and restoring a backup afterwards risks clobbering
    // a token that was rotated elsewhere in the meantime.
    const tempHome = path.join(os.tmpdir(), `codex-proxy-login-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(tempHome, { recursive: true })
    const authFile = path.join(tempHome, 'auth.json')

    const session = {
      id: `login_${Date.now().toString(36)}`,
      status: 'waiting',
      message: '正在启动隔离的 OpenAI 官方浏览器登录…',
      startedAt: new Date().toISOString(),
      label: String(body.label || body.email || '').trim(),
      routingEnabled: body.routingEnabled === true,
      tempHome,
      authFile,
      child: null,
      timer: null,
      loginId: null,
      finalizing: false
    }
    loginSession = session
    const child = spawn(process.execPath, [
      codexJs,
      '-c',
      'cli_auth_credentials_store=\"file\"',
      'app-server'
    ], {
      cwd: tempHome,
      env: {
        ...process.env,
        CODEX_HOME: tempHome,
        HOME: tempHome,
        USERPROFILE: tempHome
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    session.child = child
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8')
      let boundary
      while ((boundary = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, boundary).trim()
        stdoutBuffer = stdoutBuffer.slice(boundary + 1)
        if (!line) continue
        try { handleAppServerLoginMessage(session, JSON.parse(line)) } catch {}
      }
    })
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-6000)
    })
    child.on('error', error => finishLoginSession(session, 'error', `无法启动 Codex app-server：${error.message}`))
    child.on('exit', code => {
      if (loginSession?.id !== session.id || session.status !== 'waiting' || session.finalizing) return
      finishLoginSession(
        session,
        'error',
        stderr.trim().split(/\r?\n/).pop() || `Codex app-server 提前退出 (code ${code})`
      )
    })
    writeAppServerMessage(session, {
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'codex_proxy',
          title: 'Codex Local Multi-Upstream Proxy',
          version: '2.0.0'
        }
      }
    })
    session.timer = setTimeout(() => {
      if (session.status !== 'waiting') return
      if (session.loginId) {
        writeAppServerMessage(session, {
          method: 'account/login/cancel',
          id: 3,
          params: { loginId: session.loginId }
        })
      }
      try { session.child?.kill() } catch {}
      finishLoginSession(session, 'error', '登录等待超时，请重新发起')
    }, 15 * 60 * 1000)
    return sendJson(res, 202, publicLoginSession())
  } catch (error) {
    return sendJson(res, 500, { error: { type: 'server_error', message: error.message } })
  }
}

export function handleChatgptLoginStatus(req, res) {
  return sendJson(res, 200, publicLoginSession())
}

export function handleChatgptLoginCancel(req, res) {
  if (!isLocalAdminRequest(req)) {
    return sendJson(res, 403, {
      error: { type: 'permission_error', message: '只能从本机管理后台取消登录' }
    })
  }
  if (loginSession?.status === 'waiting') {
    loginSession.status = 'cancelled'
    loginSession.message = '登录已取消'
    if (loginSession.timer) clearTimeout(loginSession.timer)
    if (loginSession.loginId) {
      writeAppServerMessage(loginSession, {
        method: 'account/login/cancel',
        id: 3,
        params: { loginId: loginSession.loginId }
      })
    }
    try { loginSession.child?.kill() } catch {}
    cleanupLoginTemp(loginSession)
    loginSession.child = null
  }
  return sendJson(res, 200, publicLoginSession())
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
      enabled: body?.enabled
    })
    return sendJson(res, 200, {
      config: publicProxyConfig(newCfg),
      message: body?.enabled === undefined
        ? '账号路由权重已更新'
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

export function handleStatsGet(req, res) {
  return sendJson(res, 200, getStats())
}

export function handleStatsDelete(req, res) {
  return sendJson(res, 200, resetStats())
}

export function handleDiagnosticsGet(req, res) {
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
    queue: getAccountQueueDiagnostics(),
    accounts: getAccountRuntimeDiagnostics(),
    recent_route_decisions: getRouteDecisions(30),
    config_snapshots: listConfigSnapshots(),
    account_backups: listAccountBackups()
  })
}

export function handleConfigSnapshotsGet(req, res) {
  return sendJson(res, 200, { snapshots: listConfigSnapshots() })
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
      error: { type: 'invalid_request_error', message: error.message }
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
      error: { type: 'invalid_request_error', message: error.message }
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

export function handleProxyRestart(req, res) {
  sendJson(res, 202, { message: '代理将等待正在进行的请求完成后重启' })
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref()
}
