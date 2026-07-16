import { createHash } from 'node:crypto'
import type { Clock } from '../common/clock.js'
import type { KeyedDigest } from '../common/digests.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import { AuthRepository } from '../db/repositories/auth-repository.js'
import { PasswordService } from './password-service.js'
import type { ProductAccount } from './types.js'

const AUTHORIZATION_TRANSACTION_TTL_MS = 5 * 60_000
const AUTHORIZATION_CODE_TTL_MS = 2 * 60_000

export interface AuthorizationRequest {
  readonly clientId: string
  readonly redirectUri: string
  readonly responseType: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: string
  readonly state: string
}

interface AuthorizationTransaction {
  readonly id: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly state: string
  readonly expiresAtMs: number
}

export interface AuthorizationCompletion {
  readonly redirectUri: string
  readonly code: string
  readonly state: string
}

const SAFE_OAUTH_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'temporarily_unavailable'
])

function validateLoopbackRedirect(value: string): string {
  let redirect: URL
  try {
    redirect = new URL(value)
  } catch {
    throw new SafeError({
      code: 'invalid_redirect_uri',
      message: '登录回调地址无效。',
      statusCode: 400
    })
  }
  if (
    redirect.protocol !== 'http:' ||
    redirect.hostname !== '127.0.0.1' ||
    !redirect.port ||
    redirect.username ||
    redirect.password ||
    redirect.pathname !== '/callback' ||
    redirect.search ||
    redirect.hash
  ) {
    throw new SafeError({
      code: 'invalid_redirect_uri',
      message: '登录回调必须使用随机端口上的本机回调地址。',
      statusCode: 400
    })
  }
  return redirect.toString()
}

function validateEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SafeError({
      code: 'email_invalid',
      message: '请输入有效邮箱。',
      statusCode: 400
    })
  }
  return email
}

function assertAccountCanLogin(account: ProductAccount, nowMs: number): void {
  if (account.status === 'disabled') {
    throw new SafeError({
      code: 'account_disabled',
      message: '账号已被禁用。',
      statusCode: 403
    })
  }
  if (
    account.status === 'expired' ||
    (account.expiresAt !== null && Date.parse(account.expiresAt) <= nowMs)
  ) {
    throw new SafeError({
      code: 'account_expired',
      message: '账号已到期。',
      statusCode: 403
    })
  }
  if (account.organizationStatus === 'disabled') {
    throw new SafeError({
      code: 'account_disabled',
      message: '账号所属组织已被禁用。',
      statusCode: 403
    })
  }
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export class AuthorizationService {
  readonly #transactions = new Map<string, AuthorizationTransaction>()

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly digest: KeyedDigest,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  start(request: AuthorizationRequest): { authorizationTransactionId: string } {
    if (
      request.clientId !== 'ai-editor-code' ||
      request.responseType !== 'code' ||
      request.codeChallengeMethod !== 'S256' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(request.codeChallenge) ||
      !/^[A-Za-z0-9._~-]{16,512}$/.test(request.state)
    ) {
      throw new SafeError({
        code: 'invalid_authorization_request',
        message: '登录请求参数无效。',
        statusCode: 400
      })
    }
    const id = this.ids.opaque('atx')
    this.prune()
    this.#transactions.set(id, {
      id,
      clientId: request.clientId,
      redirectUri: validateLoopbackRedirect(request.redirectUri),
      codeChallenge: request.codeChallenge,
      state: request.state,
      expiresAtMs: this.clock.nowMs() + AUTHORIZATION_TRANSACTION_TTL_MS
    })
    return { authorizationTransactionId: id }
  }

  async login(options: {
    authorizationTransactionId: string
    identifier: string
    password: string
  }): Promise<AuthorizationCompletion> {
    const transaction = this.requireTransaction(options.authorizationTransactionId)
    const account = await this.repository.findAccountByIdentifier(options.identifier)
    if (!account) throw this.invalidCredentials()
    assertAccountCanLogin(account, this.clock.nowMs())
    const credential = await this.repository.getPasswordCredential(account.id)
    if (!credential || !await this.passwords.verify(credential.passwordHash, options.password)) {
      throw this.invalidCredentials()
    }
    const nowMs = this.clock.nowMs()
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= nowMs) {
      throw this.invalidCredentials()
    }
    if (credential.kind !== 'permanent' && credential.usedAt !== null) {
      throw this.invalidCredentials()
    }

    const completion = await this.repository.inTransaction(async repository => {
      if (
        credential.kind !== 'permanent' &&
        !await repository.markOneTimeCredentialUsed(account.id, this.clock.now().toISOString())
      ) {
        throw this.invalidCredentials()
      }
      return this.issueAuthorizationCode(repository, transaction, account.id)
    })
    this.#transactions.delete(transaction.id)
    return completion
  }

  async register(options: {
    authorizationTransactionId: string
    invitationCode: string
    email: string
    password: string
  }): Promise<AuthorizationCompletion> {
    const transaction = this.requireTransaction(options.authorizationTransactionId)
    const email = validateEmail(options.email)
    const passwordHash = await this.passwords.hash(options.password)
    const invitationDigest = this.digest.digest('invitation', options.invitationCode)
    const now = this.clock.now().toISOString()
    const accountId = this.ids.opaque('acct')

    const completion = await this.repository.inTransaction(async repository => {
      if (await repository.findAccountByIdentifier(email)) {
        throw new SafeError({
          code: 'email_already_registered',
          message: '该邮箱已经注册。',
          statusCode: 409
        })
      }
      const invitation = await repository.findInvitation(invitationDigest)
      if (!invitation || invitation.status === 'revoked') {
        throw new SafeError({
          code: 'invitation_invalid',
          message: '邀请码无效。',
          statusCode: 400
        })
      }
      if (invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= this.clock.nowMs()) {
        throw new SafeError({
          code: 'invitation_expired',
          message: '邀请码已过期。',
          statusCode: 400
        })
      }
      if (invitation.status === 'exhausted' || invitation.useCount >= invitation.maxUses) {
        throw new SafeError({
          code: 'invitation_exhausted',
          message: '邀请码使用次数已耗尽。',
          statusCode: 400
        })
      }
      if (!await repository.consumeInvitation(invitation.id, invitation.useCount)) {
        throw new SafeError({
          code: 'invitation_invalid',
          message: '邀请码状态已经变化，请重试。',
          statusCode: 409,
          retryable: true
        })
      }
      if (invitation.useCount + 1 >= invitation.maxUses) {
        await repository.markInvitationExhausted(invitation.id)
      }
      await repository.insertAccountAndCredential({
        id: accountId,
        loginName: null,
        email,
        role: 'user',
        organizationId: invitation.organizationId,
        mustChangePassword: false,
        mustProvideEmail: false,
        passwordHash,
        credentialKind: 'permanent',
        passwordExpiresAt: null,
        now
      })
      return this.issueAuthorizationCode(repository, transaction, accountId)
    })
    this.#transactions.delete(transaction.id)
    return completion
  }

  getTransaction(id: string): { authorizationTransactionId: string } {
    const transaction = this.requireTransaction(id)
    return { authorizationTransactionId: transaction.id }
  }

  fail(
    authorizationTransactionId: string,
    error: 'access_denied' | 'invalid_request' | 'temporarily_unavailable'
  ): string {
    const transaction = this.requireTransaction(authorizationTransactionId)
    const safeError = SAFE_OAUTH_ERRORS.has(error) ? error : 'access_denied'
    const redirect = new URL(transaction.redirectUri)
    redirect.searchParams.set('error', safeError)
    redirect.searchParams.set('state', transaction.state)
    this.#transactions.delete(transaction.id)
    return redirect.toString()
  }

  private async issueAuthorizationCode(
    repository: AuthRepository,
    transaction: AuthorizationTransaction,
    accountId: string
  ): Promise<AuthorizationCompletion> {
    const code = this.ids.secret(32)
    const nowMs = this.clock.nowMs()
    await repository.insertAuthorizationCode({
      codeDigest: this.digest.digest('authorization-code', code),
      accountId,
      pkceChallenge: transaction.codeChallenge,
      redirectUri: transaction.redirectUri,
      stateBinding: transaction.id,
      expiresAt: new Date(nowMs + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      consumedAt: null
    })
    const redirect = new URL(transaction.redirectUri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', transaction.state)
    return {
      redirectUri: redirect.toString(),
      code,
      state: transaction.state
    }
  }

  private requireTransaction(id: string): AuthorizationTransaction {
    this.prune()
    const transaction = this.#transactions.get(id)
    if (!transaction || transaction.expiresAtMs <= this.clock.nowMs()) {
      throw new SafeError({
        code: 'authorization_transaction_invalid',
        message: '登录会话已失效，请重新开始登录。',
        statusCode: 400
      })
    }
    return transaction
  }

  private prune(): void {
    const now = this.clock.nowMs()
    for (const [id, transaction] of this.#transactions) {
      if (transaction.expiresAtMs <= now) this.#transactions.delete(id)
    }
  }

  private invalidCredentials(): SafeError {
    return new SafeError({
      code: 'invalid_credentials',
      message: '账号或密码错误。',
      statusCode: 401
    })
  }
}
