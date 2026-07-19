import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { proxyConfig } from '../config.js'
import { addChatgptAccount, parseAuthJson } from '../chatgpt-accounts.js'
import { readJson, sendJson } from '../server-utils.js'
import { publicProxyConfig } from './shared.js'

let loginSession = null

export function getCodexAuthFile() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'auth.json')
}

function resolveCodexJsPath() {
  const appData = process.env.APPDATA || ''
  return process.env.CODEX_CLI_JS || path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
}

function vscodeCodexCandidates() {
  if (process.platform !== 'win32') return []
  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions')
  ]
  const archFolders = process.arch === 'arm64'
    ? ['windows-arm64', 'windows-x86_64']
    : ['windows-x86_64', 'windows-arm64']
  const candidates = []
  for (const root of roots) {
    let extensions = []
    try {
      extensions = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
        .map(entry => {
          const fullPath = path.join(root, entry.name)
          let modified = 0
          try { modified = fs.statSync(fullPath).mtimeMs } catch {}
          return { fullPath, modified }
        })
        .sort((a, b) => b.modified - a.modified)
    } catch {}
    for (const extension of extensions) {
      for (const archFolder of archFolders) {
        candidates.push({
          command: path.join(extension.fullPath, 'bin', archFolder, 'codex.exe'),
          argsPrefix: [],
          source: 'VS Code Codex 扩展'
        })
      }
    }
  }
  return candidates
}

function codexLaunchCandidates() {
  const candidates = []
  const add = candidate => {
    if (!candidate?.command || !fs.existsSync(candidate.command)) return
    const key = `${path.resolve(candidate.command).toLowerCase()}\0${(candidate.argsPrefix || []).join('\0')}`
    if (candidates.some(item => item.key === key)) return
    candidates.push({ ...candidate, key })
  }

  add({
    command: process.env.CODEX_CLI_EXE,
    argsPrefix: [],
    source: 'CODEX_CLI_EXE'
  })
  const codexJs = resolveCodexJsPath()
  if (fs.existsSync(codexJs)) {
    add({
      command: process.execPath,
      argsPrefix: [codexJs],
      source: process.env.CODEX_CLI_JS ? 'CODEX_CLI_JS' : '全局 npm Codex CLI'
    })
  }

  if (process.platform === 'win32') {
    try {
      const where = spawnSync('where.exe', ['codex'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000
      })
      for (const value of String(where.stdout || '').split(/\r?\n/)) {
        const executable = value.trim()
        if (/\.exe$/i.test(executable)) {
          add({ command: executable, argsPrefix: [], source: 'PATH 中的 Codex CLI' })
        }
      }
    } catch {}
  }
  vscodeCodexCandidates().forEach(add)
  return candidates.map(({ key, ...candidate }) => candidate)
}

export function summarizeCodexLaunchFailure(output, fallback = 'Codex CLI 无法启动') {
  const text = String(output || '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  if (/Missing optional dependency\s+(@openai\/codex-[^\s.]+)/i.test(text)) {
    const dependency = text.match(/Missing optional dependency\s+(@openai\/codex-[^\s.]+)/i)?.[1]
    return `全局 Codex CLI 安装不完整，缺少 ${dependency || '平台运行包'}`
  }
  const lines = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      line &&
      !/^Node\.js v\d+/i.test(line) &&
      !/^at\s+/i.test(line) &&
      !/^[\^~]+$/.test(line) &&
      !/^file:\/\/\//i.test(line)
    )
  return lines.find(line => /^Error:/i.test(line))?.replace(/^Error:\s*/i, '') || lines.at(-1) || fallback
}

function probeCodexLaunch(candidate) {
  try {
    const result = spawnSync(candidate.command, [...(candidate.argsPrefix || []), '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    if (!result.error && result.status === 0) {
      const appServer = spawnSync(candidate.command, [...(candidate.argsPrefix || []), 'app-server', '--help'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      })
      if (appServer.error || appServer.status !== 0) {
        return {
          ok: false,
          version: String(result.stdout || combined).trim().split(/\r?\n/)[0] || '版本未知',
          app_server: false,
          error: summarizeCodexLaunchFailure(
            `${appServer.stdout || ''}\n${appServer.stderr || ''}`.trim() || appServer.error?.message,
            '当前 Codex CLI 不支持 app-server OAuth'
          )
        }
      }
      return {
        ok: true,
        version: String(result.stdout || combined).trim().split(/\r?\n/)[0] || '版本未知',
        app_server: true
      }
    }
    return {
      ok: false,
      error: summarizeCodexLaunchFailure(combined || result.error?.message, `退出码 ${result.status}`)
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

export function resolveCodexLaunch({
  candidates = codexLaunchCandidates(),
  probe = probeCodexLaunch
} = {}) {
  const failures = []
  const checks = []
  for (const candidate of candidates) {
    const result = probe(candidate)
    checks.push({
      source: candidate.source || candidate.command,
      command: candidate.command,
      ok: result?.ok === true,
      version: result?.version || null,
      app_server: result?.app_server === true,
      error: result?.ok ? null : (result?.error || '无法启动')
    })
    if (result?.ok) {
      return {
        ...candidate,
        argsPrefix: [...(candidate.argsPrefix || [])],
        version: result.version || '版本未知',
        failures,
        checks
      }
    }
    failures.push(`${candidate.source || candidate.command}：${result?.error || '无法启动'}`)
  }
  return {
    command: null,
    argsPrefix: [],
    source: null,
    version: null,
    failures,
    checks,
    error: failures.slice(-3).join('；') || '未找到 Codex CLI 或 VS Code Codex 扩展'
  }
}

export function getChatgptLoginPreflight({
  launch = resolveCodexLaunch(),
  browser = findPrivateBrowser()
} = {}) {
  return {
    ok: Boolean(launch.command),
    selected: launch.command ? {
      source: launch.source,
      command: launch.command,
      version: launch.version,
      app_server: true
    } : null,
    candidates: launch.checks,
    browser: browser ? {
      kind: browser.kind,
      executable: browser.executable,
      private_mode: Boolean(privateBrowserArgs(browser.kind, 'https://example.com'))
    } : null,
    oauth: {
      app_server_available: Boolean(launch.command),
      private_browser_available: Boolean(browser)
    },
    repair_commands: [
      'npm uninstall -g @openai/codex',
      'npm install -g @openai/codex@latest',
      'codex --version'
    ],
    message: !launch.command
      ? `没有可用的 Codex app-server：${launch.error}`
      : (!browser
          ? '未找到支持私密模式的 Chrome、Edge 或 Firefox'
          : `预检通过，将使用 ${launch.source} ${launch.version} 和 ${browser.kind} 私密窗口`)
  }
}

// Best-effort: finds any local process whose command line references the
// resolved codex.js (the CLI, its `login` subprocess, etc) and kills it, so a
// freshly-switched-to account's auth.json is picked up on next Codex invocation.
// Matches on the codex.js path specifically so this can never kill this proxy's
// own server.js process.
export function killLocalCodexProcesses() {
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
    privateBrowserKind: loginSession.privateBrowserKind || null,
    codexSource: loginSession.codexSource || null,
    codexVersion: loginSession.codexVersion || null
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

export function officialLoginUrlWithHint(authUrl, email) {
  try {
    const url = new URL(String(authUrl || ''))
    const hostname = url.hostname.toLowerCase()
    const loginEmail = String(email || '').trim()
    if (
      url.protocol !== 'https:' ||
      !(hostname === 'openai.com' || hostname.endsWith('.openai.com')) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)
    ) {
      return String(authUrl || '')
    }
    url.searchParams.set('login_hint', loginEmail)
    return url.toString()
  } catch {
    return String(authUrl || '')
  }
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
    const upgradingTemporary = duplicate &&
      (duplicate.credential_mode === 'temporary_access' || !duplicate.refresh_token)
    if (duplicate && !upgradingTemporary) {
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
    finishLoginSession(
      session,
      'success',
      upgradingTemporary
        ? `官方登录成功，临时账号已升级为可自动续约账号${usageMessage}`
        : `官方登录成功，账号已自动加入账号池${usageMessage}`
    )
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
    session.verificationUrl = officialLoginUrlWithHint(result.authUrl, session.email)
    session.privateBrowserAttempted = true
    session.privateBrowserKind = openPrivateBrowser(session.verificationUrl)
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
    const codexLaunch = resolveCodexLaunch()
    if (!codexLaunch.command) {
      return sendJson(res, 503, {
        error: {
          type: 'service_unavailable',
          message: `未找到可用的 Codex CLI。${codexLaunch.error}。请修复全局安装，或安装/更新 OpenAI Codex VS Code 扩展。`
        }
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
      message: `正在通过 ${codexLaunch.source} 启动隔离的 OpenAI 官方浏览器登录…`,
      startedAt: new Date().toISOString(),
      label: String(body.label || body.email || '').trim(),
      email: String(body.email || '').trim(),
      routingEnabled: body.routingEnabled === true,
      tempHome,
      authFile,
      child: null,
      timer: null,
      loginId: null,
      finalizing: false,
      codexSource: codexLaunch.source,
      codexVersion: codexLaunch.version
    }
    loginSession = session
    const child = spawn(codexLaunch.command, [
      ...codexLaunch.argsPrefix,
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
        summarizeCodexLaunchFailure(stderr, `Codex app-server 提前退出 (code ${code})`)
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

export function handleChatgptLoginPreflight(req, res) {
  const preflight = getChatgptLoginPreflight()
  return sendJson(res, preflight.ok ? 200 : 503, preflight)
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
