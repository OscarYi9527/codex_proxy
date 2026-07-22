import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IdSource } from '../common/ids.js'
import { SafeError } from '../common/errors.js'

export type ChatgptLoginState = 'idle' | 'waiting' | 'success' | 'error' | 'cancelled'

export interface ChatgptLoginStatus {
  readonly id?: string
  readonly status: ChatgptLoginState
  readonly message?: string
  readonly startedAt?: string
  readonly verificationUrl?: string | null
  readonly userCode?: string | null
  readonly codexSource?: string | null
  readonly codexVersion?: string | null
}

export interface ChatgptLoginCoordinator {
  start(
    providerId: string,
    importCredential: (authJson: string) => Promise<void>
  ): Promise<ChatgptLoginStatus>
  status(providerId: string): ChatgptLoginStatus
  close(): Promise<void>
}

interface LoginSession {
  readonly id: string
  readonly providerId: string
  readonly startedAt: string
  readonly tempHome: string
  readonly authFile: string
  readonly importCredential: (authJson: string) => Promise<void>
  status: Exclude<ChatgptLoginState, 'idle'>
  message: string
  verificationUrl: string | null
  userCode: string | null
  codexSource: string | null
  codexVersion: string | null
  child: ChildProcessWithoutNullStreams | null
  timer: NodeJS.Timeout | null
  finalizing: boolean
}

interface CodexLaunch {
  readonly command: string | null
  readonly argsPrefix?: readonly string[]
  readonly source?: string | null
  readonly version?: string | null
  readonly error?: string
}

function publicSession(session: LoginSession | null): ChatgptLoginStatus {
  if (!session) return { status: 'idle' }
  return {
    id: session.id,
    status: session.status,
    message: session.message,
    startedAt: session.startedAt,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    codexSource: session.codexSource,
    codexVersion: session.codexVersion
  }
}

function assertUsableAuthJson(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const source = parsed['tokens'] && typeof parsed['tokens'] === 'object'
      ? parsed['tokens'] as Record<string, unknown>
      : parsed
    if (!source['access_token'] && !source['accessToken'] &&
        !source['refresh_token'] && !source['refreshToken']) {
      throw new Error('tokens missing')
    }
  } catch {
    throw new Error('Codex 登录完成，但生成的认证文件无效。')
  }
}

function isTrustedOpenAiLoginUrl(value: unknown): value is string {
  return typeof value === 'string' &&
    /^https:\/\/(?:auth\.openai\.com|chatgpt\.com)\//i.test(value)
}

function deviceAuthDetails(value: string): {
  readonly verificationUrl: string | null
  readonly userCode: string | null
} {
  const text = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  const urls = [...text.matchAll(/https:\/\/[^\s<>"']+/gi)]
    .map(match => match[0].replace(/[.,;:)]+$/, ''))
  const verificationUrl = urls.find(isTrustedOpenAiLoginUrl) || null
  const userCode = text.match(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/)?.[0] || null
  return { verificationUrl, userCode }
}

function appendNoProxy(current: string | undefined): string {
  const values = new Set(
    String(current || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )
  for (const value of ['127.0.0.1', 'localhost', '::1']) values.add(value)
  return [...values].join(',')
}

function loginProxyEnvironment(): NodeJS.ProcessEnv {
  const proxy = process.env['AI_EDITOR_CHATGPT_LOGIN_HTTPS_PROXY']?.trim()
  if (!proxy) return {}
  try {
    const parsed = new URL(proxy)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {}
  } catch {
    return {}
  }
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: appendNoProxy(process.env['NO_PROXY'])
  }
}

function safeExitReason(output: string, code: number | null): string {
  const text = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  if (/Missing optional dependency|Node\.js v\d+/i.test(text)) {
    return 'Codex CLI 启动失败，请检查 CLI 安装是否完整。'
  }
  if (/expired|device code.*invalid|invalid.*device code/i.test(text)) {
    return 'OpenAI 一次性登录代码已失效，请重新发起官方登录。'
  }
  if (/access_denied|authorization denied|authorization.*cancel/i.test(text)) {
    return 'OpenAI 官方登录已取消或未授权。'
  }
  if (
    /timed?\s*out|network|connection|connect|dns|tls|certificate|request error|error sending request|failed to send/i
      .test(text)
  ) {
    return 'Gateway 无法完成 OpenAI 登录令牌交换，请检查订阅登录专用外网出口后重试。'
  }
  return `Codex device-auth 提前退出（code ${code ?? 'unknown'}）。`
}

export class ProcessChatgptLoginService implements ChatgptLoginCoordinator {
  #session: LoginSession | null = null

  constructor(
    private readonly dataRoot: string,
    private readonly ids: IdSource,
    private readonly now: () => Date = () => new Date()
  ) {}

  async start(
    providerId: string,
    importCredential: (authJson: string) => Promise<void>
  ): Promise<ChatgptLoginStatus> {
    if (this.#session?.status === 'waiting') {
      throw new SafeError({
        code: 'chatgpt_login_in_progress',
        message: '已有 OpenAI 官方登录正在进行，请先完成后再重试。',
        statusCode: 409
      })
    }
    const launch = await this.resolveLaunch()
    if (!launch.command) {
      throw new SafeError({
        code: 'codex_cli_unavailable',
        message: `没有可用的 Codex CLI。${launch.error || '请安装或更新 Codex CLI。'}`,
        statusCode: 503
      })
    }

    const id = this.ids.opaque('oauth')
    const tempHome = path.join(this.dataRoot, '.oauth-login', id)
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 })
    const session: LoginSession = {
      id,
      providerId,
      startedAt: this.now().toISOString(),
      tempHome,
      authFile: path.join(tempHome, 'auth.json'),
      importCredential,
      status: 'waiting',
      message: '正在启动隔离的 OpenAI 官方登录…',
      verificationUrl: null,
      userCode: null,
      codexSource: launch.source || null,
      codexVersion: launch.version || null,
      child: null,
      timer: null,
      finalizing: false
    }
    this.#session = session

    try {
      const child = spawn(launch.command, [
        ...(launch.argsPrefix || []),
        '-c',
        'cli_auth_credentials_store="file"',
        'login',
        '--device-auth'
      ], {
        cwd: tempHome,
        env: {
          ...process.env,
          ...loginProxyEnvironment(),
          CODEX_HOME: tempHome,
          HOME: tempHome,
          USERPROFILE: tempHome
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      session.child = child
      this.attach(session, child)
      session.timer = setTimeout(() => {
        if (session.status !== 'waiting') return
        void this.stopAndFinish(
          session,
          'error',
          'OpenAI 官方登录等待超时，请重新发起。'
        )
      }, 15 * 60 * 1000)
      session.timer.unref()
      return publicSession(session)
    } catch (error) {
      this.finish(
        session,
        'error',
        `无法启动 Codex CLI：${error instanceof Error ? error.message : '未知错误'}`
      )
      return publicSession(session)
    }
  }

  status(providerId: string): ChatgptLoginStatus {
    if (!this.#session || this.#session.providerId !== providerId) {
      return { status: 'idle' }
    }
    return publicSession(this.#session)
  }

  async close(): Promise<void> {
    const session = this.#session
    if (!session) return
    if (session.status === 'waiting') {
      await this.stopAndFinish(session, 'cancelled', 'Gateway 已停止，登录已取消。')
    }
  }

  private attach(session: LoginSession, child: ChildProcessWithoutNullStreams): void {
    let output = ''
    const consume = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-12_000)
      const details = deviceAuthDetails(output)
      if (details.verificationUrl) session.verificationUrl = details.verificationUrl
      if (details.userCode) session.userCode = details.userCode
      if (session.verificationUrl) {
        session.message = session.userCode
          ? `请在系统浏览器打开登录地址，并输入一次性代码 ${session.userCode}。`
          : '请在系统浏览器打开登录地址，并按页面提示完成 OpenAI 官方登录。'
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', chunk => consume(Buffer.from(chunk)))
    child.on('error', error => {
      this.finish(session, 'error', `无法启动 Codex CLI：${error.message}`)
    })
    child.on('exit', code => {
      if (this.#session?.id !== session.id ||
          session.status !== 'waiting' ||
          session.finalizing) return

      // Some Codex CLI builds return code 1 after the browser reports success,
      // even though the isolated auth.json was durably written. The credential
      // file is the authoritative completion signal; import it before judging
      // the process exit code.
      if (fs.existsSync(session.authFile) || code === 0) {
        void this.importCompletedLogin(session)
        return
      }
      this.finish(session, 'error', safeExitReason(output, code))
    })
  }

  private async importCompletedLogin(session: LoginSession): Promise<void> {
    if (session.finalizing || this.#session?.id !== session.id) return
    session.finalizing = true
    try {
      if (!session.verificationUrl || !session.userCode) {
        throw new Error('Codex device-auth 未返回有效的官方登录地址或一次性代码。')
      }
      for (let attempt = 0; attempt < 30 && !fs.existsSync(session.authFile); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!fs.existsSync(session.authFile)) {
        throw new Error('登录完成，但隔离目录中没有生成 auth.json。')
      }
      const raw = fs.readFileSync(session.authFile, 'utf8')
      assertUsableAuthJson(raw)
      await session.importCredential(raw)
      await this.stopChild(session)
      this.finish(session, 'success', 'OpenAI 官方登录成功，订阅账号已加入账号池。')
    } catch (error) {
      await this.stopChild(session)
      this.finish(
        session,
        'error',
        error instanceof Error ? error.message : 'OpenAI 官方登录导入失败。'
      )
    }
  }

  private cancelChild(session: LoginSession): void {
    try { session.child?.kill() } catch {}
  }

  private async stopChild(session: LoginSession): Promise<void> {
    const child = session.child
    if (!child) return
    try { child.kill() } catch {}
    if (child.exitCode !== null) return
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 500))
    ])
    if (child.exitCode === null && process.platform === 'win32' && child.pid) {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 1000))
      ])
    }
    if (child.exitCode !== null) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  private async stopAndFinish(
    session: LoginSession,
    status: LoginSession['status'],
    message: string
  ): Promise<void> {
    if (session.finalizing || this.#session?.id !== session.id) return
    session.finalizing = true
    this.cancelChild(session)
    await this.stopChild(session)
    this.finish(session, status, message)
  }

  private finish(
    session: LoginSession,
    status: LoginSession['status'],
    message: string
  ): void {
    if (this.#session?.id !== session.id) return
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    session.child = null
    try {
      fs.rmSync(session.tempHome, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50
      })
      session.status = status
      session.message = message
    } catch {
      session.status = 'error'
      session.message = '隔离登录目录清理失败，请重启 Gateway 后重试。'
    }
  }

  private async resolveLaunch(): Promise<CodexLaunch> {
    const sourceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..'
    )
    const module = await import(
      pathToFileURL(path.join(sourceRoot, 'src', 'admin', 'login.js')).href
    ) as {
      resolveCodexLaunch(): CodexLaunch
    }
    return module.resolveCodexLaunch()
  }
}
