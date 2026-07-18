import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
  codexSource: string | null
  codexVersion: string | null
  loginId: string | null
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
        message: `没有可用的 Codex app-server。${launch.error || '请安装或更新 Codex CLI。'}`,
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
      codexSource: launch.source || null,
      codexVersion: launch.version || null,
      loginId: null,
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
      this.attach(session, child)
      this.write(session, {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'ai-editor-gateway',
            title: 'AI Editor Gateway',
            version: '0.1.0'
          }
        }
      })
      session.timer = setTimeout(() => {
        if (session.status !== 'waiting') return
        this.cancelChild(session)
        this.finish(session, 'error', 'OpenAI 官方登录等待超时，请重新发起。')
      }, 15 * 60 * 1000)
      session.timer.unref()
      return publicSession(session)
    } catch (error) {
      this.finish(
        session,
        'error',
        `无法启动 Codex app-server：${error instanceof Error ? error.message : '未知错误'}`
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
      this.cancelChild(session)
      this.finish(session, 'cancelled', 'Gateway 已停止，登录已取消。')
    }
  }

  private attach(session: LoginSession, child: ChildProcessWithoutNullStreams): void {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
      let boundary = stdout.indexOf('\n')
      while (boundary >= 0) {
        const line = stdout.slice(0, boundary).trim()
        stdout = stdout.slice(boundary + 1)
        if (line) {
          try {
            this.handleMessage(session, JSON.parse(line) as Record<string, unknown>)
          } catch {
            // Codex may emit non-protocol output; never surface it because it can contain details.
          }
        }
        boundary = stdout.indexOf('\n')
      }
    })
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    child.on('error', error => {
      this.finish(session, 'error', `无法启动 Codex app-server：${error.message}`)
    })
    child.on('exit', code => {
      if (this.#session?.id !== session.id ||
          session.status !== 'waiting' ||
          session.finalizing) return
      const safeReason = /^Node\.js v\d+/im.test(stderr)
        ? 'Codex CLI 启动失败，请检查 CLI 安装是否完整。'
        : `Codex app-server 提前退出（code ${code ?? 'unknown'}）。`
      this.finish(session, 'error', safeReason)
    })
  }

  private handleMessage(session: LoginSession, message: Record<string, unknown>): void {
    if (this.#session?.id !== session.id || session.status !== 'waiting') return
    if (message['id'] === 1) {
      if (message['error']) {
        this.cancelChild(session)
        this.finish(session, 'error', 'Codex app-server 初始化失败。')
        return
      }
      this.write(session, { method: 'initialized', params: {} })
      this.write(session, {
        method: 'account/login/start',
        id: 2,
        params: { type: 'chatgpt' }
      })
      return
    }
    if (message['id'] === 2) {
      const error = message['error']
      const result = message['result'] as Record<string, unknown> | undefined
      if (error || !isTrustedOpenAiLoginUrl(result?.['authUrl']) ||
          typeof result['loginId'] !== 'string') {
        this.cancelChild(session)
        this.finish(session, 'error', 'Codex app-server 未返回有效的登录地址。')
        return
      }
      session.loginId = result['loginId']
      session.verificationUrl = result['authUrl']
      session.message = '请在浏览器中打开登录地址并完成 OpenAI 官方登录。'
      return
    }
    if (message['method'] !== 'account/login/completed') return
    const params = message['params'] as Record<string, unknown> | undefined
    if (session.loginId && params?.['loginId'] !== session.loginId) return
    if (params?.['success'] !== true) {
      this.cancelChild(session)
      this.finish(session, 'error', 'OpenAI 官方登录未完成。')
      return
    }
    void this.importCompletedLogin(session)
  }

  private async importCompletedLogin(session: LoginSession): Promise<void> {
    if (session.finalizing || this.#session?.id !== session.id) return
    session.finalizing = true
    try {
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
      this.finish(session, 'success', 'OpenAI 官方登录成功，账号凭据已导入 Gateway。')
    } catch (error) {
      await this.stopChild(session)
      this.finish(
        session,
        'error',
        error instanceof Error ? error.message : 'OpenAI 官方登录导入失败。'
      )
    }
  }

  private write(session: LoginSession, message: Record<string, unknown>): void {
    if (!session.child?.stdin.writable) return
    session.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private cancelChild(session: LoginSession): void {
    if (session.loginId) {
      this.write(session, {
        method: 'account/login/cancel',
        id: 3,
        params: { loginId: session.loginId }
      })
    }
    try { session.child?.kill() } catch {}
  }

  private async stopChild(session: LoginSession): Promise<void> {
    const child = session.child
    if (!child) return
    try { child.kill() } catch {}
    if (child.exitCode !== null) return
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 2000))
    ])
    if (child.exitCode === null && process.platform === 'win32' && child.pid) {
      // A Windows process can survive the regular Node signal briefly while
      // retaining the isolated CODEX_HOME directory. It is our own child, so
      // terminate its process tree before deleting credentials from that home.
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 2000))
      ])
    }
    // Let Windows release the exited process' file handles before finish()
    // removes the per-login CODEX_HOME.
    if (child.exitCode !== null) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
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
    try { fs.rmSync(session.tempHome, { recursive: true, force: true }) } catch {}
    session.status = status
    session.message = message
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
