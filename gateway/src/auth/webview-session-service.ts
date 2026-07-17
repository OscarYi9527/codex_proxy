import type { FastifyRequest } from 'fastify'
import type { Clock } from '../common/clock.js'
import type { KeyedDigest } from '../common/digests.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  WebviewSessionRepository,
  type AccountDeviceContext,
  type WebviewSessionContext
} from '../db/repositories/webview-session-repository.js'
import type { AccessIdentity, AccountRole } from './types.js'

export const MANAGEMENT_COOKIE_NAME = 'ai_editor_management_session'
const TICKET_TTL_MS = 60_000
const SESSION_TTL_MS = 30 * 60_000

export type ManagementRoute =
  | 'account'
  | 'security'
  | 'organization'
  | 'invitations'
  | 'usage'
  | 'providers'
  | 'diagnostics'

export interface ManagementNavigationItem {
  readonly id: ManagementRoute
  readonly label: string
}

const USER_NAVIGATION: readonly ManagementNavigationItem[] = [
  { id: 'account', label: '我的账号' },
  { id: 'security', label: '设备与安全' },
  { id: 'usage', label: '使用记录' }
]

function navigationForRole(role: AccountRole): readonly ManagementNavigationItem[] {
  if (role === 'user') return USER_NAVIGATION
  const organization = [
    ...USER_NAVIGATION,
    { id: 'organization' as const, label: '组织用户' },
    { id: 'invitations' as const, label: '邀请码' }
  ]
  return role === 'level2'
    ? organization
    : [
        ...organization,
        { id: 'providers', label: 'Provider 与模型' },
        { id: 'diagnostics', label: '系统诊断' }
      ]
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  const matches = header
    .split(';')
    .map(item => item.trim())
    .filter(item => item.startsWith(`${name}=`))
  if (matches.length !== 1) return null
  const value = matches[0]?.slice(name.length + 1) || ''
  return /^[A-Za-z0-9_-]{32,256}$/.test(value) ? value : null
}

function assertDeviceActive(context: AccountDeviceContext, nowMs: number): void {
  const now = new Date(nowMs).toISOString()
  if (
    context.deviceRevokedAt !== null ||
    context.deviceExpiresAt <= now ||
    context.sessionPasswordVersion !== context.credentialPasswordVersion
  ) {
    throw loginRequired()
  }
  if (
    context.accountStatus !== 'active' ||
    context.organizationStatus === 'disabled' ||
    (context.accountExpiresAt !== null && Date.parse(context.accountExpiresAt) <= nowMs)
  ) {
    throw new SafeError({
      code: 'account_disabled',
      message: '账号或组织当前不可用。',
      statusCode: 403
    })
  }
}

function assertSessionActive(context: WebviewSessionContext, nowMs: number): void {
  const now = new Date(nowMs).toISOString()
  if (context.webviewRevokedAt !== null || context.webviewExpiresAt <= now) {
    throw loginRequired()
  }
  assertDeviceActive(context, nowMs)
}

function loginRequired(): SafeError {
  return new SafeError({
    code: 'login_required',
    message: 'AI Editor 管理会话无效或已过期。',
    statusCode: 401
  })
}

export class WebviewSessionService {
  constructor(
    private readonly repository: WebviewSessionRepository,
    private readonly digest: KeyedDigest,
    private readonly clock: Clock,
    private readonly ids: IdSource,
    readonly publicOrigin: string,
    readonly secureCookie: boolean
  ) {}

  async issueTicket(
    identity: AccessIdentity,
    body: Record<string, unknown>
  ): Promise<{ ticket: string; expiresIn: number }> {
    if (
      body['audience'] !== this.publicOrigin ||
      body['purpose'] !== 'account-management'
    ) {
      throw new SafeError({
        code: 'invalid_webview_audience',
        message: '管理页面目标地址无效。',
        statusCode: 400
      })
    }
    const ticket = this.ids.secret(32)
    await this.repository.insertTicket({
      ticketDigest: this.digest.digest('webview-ticket', ticket),
      accountId: identity.accountId,
      deviceSessionId: identity.deviceSessionId,
      audience: this.publicOrigin,
      roleVersion: identity.accountVersion,
      expiresAt: new Date(this.clock.nowMs() + TICKET_TTL_MS).toISOString(),
      consumedAt: null
    })
    return { ticket, expiresIn: TICKET_TTL_MS / 1000 }
  }

  async exchange(ticket: string): Promise<{
    cookie: string
    expiresIn: number
    account: { id: string; role: AccountRole }
    navigation: readonly ManagementNavigationItem[]
  }> {
    if (typeof ticket !== 'string' || ticket.length < 32) throw this.invalidTicket()
    const ticketDigest = this.digest.digest('webview-ticket', ticket)
    return this.repository.inTransaction(async repository => {
      const record = await repository.getTicket(ticketDigest)
      const now = this.clock.now().toISOString()
      if (
        !record ||
        record.consumedAt !== null ||
        record.expiresAt <= now ||
        record.audience !== this.publicOrigin
      ) {
        throw this.invalidTicket()
      }
      const deviceContext = await repository.getSessionContextForDevice(
        record.deviceSessionId,
        record.accountId
      )
      if (!deviceContext) throw this.invalidTicket()
      assertDeviceActive(deviceContext, this.clock.nowMs())
      if (
        record.roleVersion !== deviceContext.accountVersion ||
        !await repository.consumeTicket(ticketDigest, now)
      ) {
        throw this.invalidTicket()
      }
      const rawSession = this.ids.secret(48)
      const expiresIn = SESSION_TTL_MS / 1000
      await repository.insertSession({
        sessionDigest: this.digest.digest('webview-session', rawSession),
        accountId: record.accountId,
        deviceSessionId: record.deviceSessionId,
        expiresAt: new Date(this.clock.nowMs() + SESSION_TTL_MS).toISOString()
      })
      return {
        cookie: this.serializeCookie(rawSession, expiresIn),
        expiresIn,
        account: {
          id: deviceContext.accountId,
          role: deviceContext.role
        },
        navigation: navigationForRole(deviceContext.role)
      }
    })
  }

  async authenticateRequest(request: FastifyRequest): Promise<AccessIdentity> {
    if (!['GET', 'HEAD'].includes(request.method)) this.assertOrigin(request)
    const rawSession = parseCookie(request.headers.cookie, MANAGEMENT_COOKIE_NAME)
    if (!rawSession) throw loginRequired()
    const context = await this.repository.getSessionContext(
      this.digest.digest('webview-session', rawSession)
    )
    if (!context) throw loginRequired()
    assertSessionActive(context, this.clock.nowMs())
    return {
      accountId: context.accountId,
      deviceSessionId: context.deviceSessionId,
      role: context.role,
      organizationId: context.organizationId,
      accountVersion: context.accountVersion,
      passwordVersion: context.credentialPasswordVersion
    }
  }

  async revokeRequestSession(request: FastifyRequest): Promise<void> {
    this.assertOrigin(request)
    const rawSession = parseCookie(request.headers.cookie, MANAGEMENT_COOKIE_NAME)
    if (!rawSession) return
    await this.repository.revokeSession(
      this.digest.digest('webview-session', rawSession),
      this.clock.now().toISOString()
    )
  }

  clearCookie(): string {
    return this.serializeCookie('', 0)
  }

  private assertOrigin(request: FastifyRequest): void {
    if (request.headers.origin !== this.publicOrigin) {
      throw new SafeError({
        code: 'invalid_management_origin',
        message: '管理页面请求来源无效。',
        statusCode: 403
      })
    }
  }

  private serializeCookie(value: string, maxAge: number): string {
    return [
      `${MANAGEMENT_COOKIE_NAME}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(this.secureCookie ? ['Secure'] : [])
    ].join('; ')
  }

  private invalidTicket(): SafeError {
    return new SafeError({
      code: 'webview_ticket_invalid',
      message: '管理页面票据无效或已过期。',
      statusCode: 400
    })
  }
}
