import { SignJWT, jwtVerify } from 'jose'
import type { Clock } from '../common/clock.js'
import type { KeyedDigest } from '../common/digests.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import { AuthRepository } from '../db/repositories/auth-repository.js'
import { pkceS256 } from './authorization-service.js'
import type {
  AccessIdentity,
  DeviceDescriptor,
  IssuedTokenSet,
  ProductAccount
} from './types.js'

const ACCESS_TOKEN_TTL_SECONDS = 5 * 60
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const ACCESS_TOKEN_ISSUER = 'ai-editor-gateway'
const ACCESS_TOKEN_AUDIENCE = 'ai-editor-edge'

function assertAccountActive(account: ProductAccount, nowMs: number): void {
  if (account.status === 'disabled' || account.organizationStatus === 'disabled') {
    throw new SafeError({
      code: 'account_disabled',
      message: '账号或组织已被禁用。',
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
}

function validateDevice(value: DeviceDescriptor): DeviceDescriptor {
  const name = typeof value?.name === 'string' ? value.name.trim().slice(0, 240) : ''
  if (!name) {
    throw new SafeError({
      code: 'invalid_device',
      message: '设备信息无效。',
      statusCode: 400
    })
  }
  const platform = ['windows', 'macos', 'other'].includes(value.platform)
    ? value.platform
    : 'other'
  return { name, platform }
}

export class TokenService {
  readonly #accessKey: Uint8Array

  constructor(
    private readonly repository: AuthRepository,
    private readonly digest: KeyedDigest,
    accessKey: Uint8Array,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {
    if (accessKey.byteLength < 32) throw new Error('Access Token key must contain at least 32 bytes')
    this.#accessKey = new Uint8Array(accessKey)
  }

  async exchangeAuthorizationCode(options: {
    clientId: string
    code: string
    codeVerifier: string
    redirectUri: string
    device: DeviceDescriptor
  }): Promise<IssuedTokenSet> {
    if (
      options.clientId !== 'ai-editor-code' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(options.codeVerifier)
    ) {
      throw this.invalidGrant()
    }
    const codeDigest = this.digest.digest('authorization-code', options.code)
    const device = validateDevice(options.device)
    return this.repository.inTransaction(async repository => {
      const code = await repository.getAuthorizationCode(codeDigest)
      if (
        !code ||
        code.consumedAt !== null ||
        code.expiresAt <= this.clock.now().toISOString() ||
        code.redirectUri !== options.redirectUri ||
        code.pkceChallenge !== pkceS256(options.codeVerifier)
      ) {
        throw this.invalidGrant()
      }
      if (!await repository.consumeAuthorizationCode(codeDigest, this.clock.now().toISOString())) {
        throw this.invalidGrant()
      }
      const account = await repository.findAccountById(code.accountId)
      const credential = account
        ? await repository.getPasswordCredential(account.id)
        : null
      if (!account || !credential) throw this.invalidGrant()
      assertAccountActive(account, this.clock.nowMs())
      return this.createSessionTokenSet(repository, account, credential.passwordVersion, device)
    })
  }

  async rotateRefreshToken(options: {
    clientId: string
    refreshToken: string
    deviceSessionId: string
  }): Promise<IssuedTokenSet> {
    if (
      options.clientId !== 'ai-editor-edge' ||
      typeof options.refreshToken !== 'string' ||
      options.refreshToken.length < 32 ||
      typeof options.deviceSessionId !== 'string'
    ) {
      throw this.invalidGrant()
    }
    const tokenDigest = this.digest.digest('refresh-token', options.refreshToken)
    const outcome = await this.repository.inTransaction(async repository => {
      const context = await repository.getRefreshContext(tokenDigest)
      if (!context || context.sessionId !== options.deviceSessionId) throw this.invalidGrant()
      const now = this.clock.now().toISOString()
      if (context.consumedAt !== null) {
        await repository.revokeTokenFamily(
          context.familyId,
          context.sessionId,
          now,
          'refresh_token_reuse_detected'
        )
        return { reuseDetected: true as const }
      }
      if (
        context.tokenRevokedAt !== null ||
        context.sessionRevokedAt !== null ||
        context.tokenExpiresAt <= now ||
        context.sessionExpiresAt <= now ||
        context.sessionPasswordVersion !== context.credentialPasswordVersion
      ) {
        throw this.invalidGrant()
      }
      assertAccountActive(context.account, this.clock.nowMs())
      if (!await repository.consumeRefreshToken(context.tokenId, now)) {
        await repository.revokeTokenFamily(
          context.familyId,
          context.sessionId,
          now,
          'refresh_token_reuse_detected'
        )
        return { reuseDetected: true as const }
      }
      const refreshToken = this.ids.secret(48)
      const refreshExpiresAt = new Date(
        this.clock.nowMs() + REFRESH_TOKEN_TTL_SECONDS * 1000
      ).toISOString()
      await repository.insertRefreshToken({
        id: this.ids.opaque('rt'),
        sessionId: context.sessionId,
        familyId: context.familyId,
        digest: this.digest.digest('refresh-token', refreshToken),
        parentTokenId: context.tokenId,
        issuedAt: now,
        expiresAt: refreshExpiresAt
      })
      await repository.touchDeviceSession(context.sessionId, now, refreshExpiresAt)
      return {
        reuseDetected: false as const,
        tokens: await this.composeTokenSet(
          context.account,
          context.credentialPasswordVersion,
          context.sessionId,
          refreshToken
        )
      }
    })
    if (outcome.reuseDetected) {
      throw new SafeError({
        code: 'refresh_token_reuse_detected',
        message: '检测到登录凭据重放，当前设备会话已撤销。',
        statusCode: 401
      })
    }
    return outcome.tokens
  }

  async verifyAccessToken(token: string): Promise<AccessIdentity | null> {
    try {
      return await this.authenticateAccessToken(token, { allowPasswordChange: true })
    } catch {
      return null
    }
  }

  async authenticateAccessToken(
    token: string,
    options: { allowPasswordChange?: boolean; allowInactive?: boolean } = {}
  ): Promise<AccessIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.#accessKey, {
        algorithms: ['HS256'],
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        currentDate: this.clock.now()
      })
      const accountId = payload.sub
      const sessionId = payload['sid']
      const role = payload['role']
      const organizationId = payload['org']
      const accountVersion = payload['av']
      const passwordVersion = payload['pv']
      if (
        typeof accountId !== 'string' ||
        typeof sessionId !== 'string' ||
        !['level1', 'level2', 'user'].includes(String(role)) ||
        !(organizationId === null || typeof organizationId === 'string') ||
        !Number.isInteger(accountVersion) ||
        !Number.isInteger(passwordVersion)
      ) {
        throw this.loginRequired()
      }
      const context = await this.repository.getAccessSessionContext(sessionId)
      if (!context || context.account.id !== accountId) throw this.loginRequired()
      const now = this.clock.now().toISOString()
      if (
        context.sessionRevokedAt !== null ||
        context.sessionExpiresAt <= now ||
        context.sessionPasswordVersion !== context.credentialPasswordVersion ||
        context.credentialPasswordVersion !== passwordVersion ||
        context.account.version !== accountVersion
      ) {
        throw this.loginRequired()
      }
      if (!options.allowInactive) assertAccountActive(context.account, this.clock.nowMs())
      if (
        !options.allowPasswordChange &&
        (context.account.mustChangePassword || context.account.mustProvideEmail)
      ) {
        throw new SafeError({
          code: 'password_change_required',
          message: '必须先修改临时密码并完善账号信息。',
          statusCode: 409
        })
      }
      return {
        accountId,
        deviceSessionId: sessionId,
        role: role as AccessIdentity['role'],
        organizationId: organizationId as string | null,
        accountVersion,
        passwordVersion
      }
    } catch (error) {
      if (error instanceof SafeError) throw error
      throw this.loginRequired()
    }
  }

  async reissueAfterPasswordChange(options: {
    repository: AuthRepository
    account: ProductAccount
    passwordVersion: number
    deviceSessionId: string
  }): Promise<IssuedTokenSet> {
    const now = this.clock.now().toISOString()
    const refreshExpiresAt = new Date(
      this.clock.nowMs() + REFRESH_TOKEN_TTL_SECONDS * 1000
    ).toISOString()
    await options.repository.resetCurrentSessionAfterPasswordChange({
      sessionId: options.deviceSessionId,
      passwordVersion: options.passwordVersion,
      now,
      expiresAt: refreshExpiresAt
    })
    const refreshToken = this.ids.secret(48)
    await options.repository.insertRefreshToken({
      id: this.ids.opaque('rt'),
      sessionId: options.deviceSessionId,
      familyId: this.ids.opaque('rt'),
      digest: this.digest.digest('refresh-token', refreshToken),
      parentTokenId: null,
      issuedAt: now,
      expiresAt: refreshExpiresAt
    })
    return this.composeTokenSet(
      options.account,
      options.passwordVersion,
      options.deviceSessionId,
      refreshToken
    )
  }

  private async createSessionTokenSet(
    repository: AuthRepository,
    account: ProductAccount,
    passwordVersion: number,
    device: DeviceDescriptor
  ): Promise<IssuedTokenSet> {
    const now = this.clock.now().toISOString()
    const refreshExpiresAt = new Date(
      this.clock.nowMs() + REFRESH_TOKEN_TTL_SECONDS * 1000
    ).toISOString()
    const sessionId = this.ids.opaque('ds')
    await repository.revokeActiveSessionsForDevice(account.id, device, now)
    await repository.createDeviceSession({
      id: sessionId,
      accountId: account.id,
      device,
      passwordVersion,
      now,
      expiresAt: refreshExpiresAt
    })
    const refreshToken = this.ids.secret(48)
    const familyId = this.ids.opaque('rt')
    await repository.insertRefreshToken({
      id: this.ids.opaque('rt'),
      sessionId,
      familyId,
      digest: this.digest.digest('refresh-token', refreshToken),
      parentTokenId: null,
      issuedAt: now,
      expiresAt: refreshExpiresAt
    })
    return this.composeTokenSet(account, passwordVersion, sessionId, refreshToken)
  }

  private async composeTokenSet(
    account: ProductAccount,
    passwordVersion: number,
    sessionId: string,
    refreshToken: string
  ): Promise<IssuedTokenSet> {
    const issuedAt = Math.floor(this.clock.nowMs() / 1000)
    const accessToken = await new SignJWT({
      sid: sessionId,
      role: account.role,
      org: account.organizationId,
      av: account.version,
      pv: passwordVersion
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject(account.id)
      .setJti(this.ids.opaque('rt'))
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.#accessKey)
    return {
      accessToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      deviceSessionId: sessionId,
      account: {
        id: account.id,
        display: account.email || account.loginName || 'AI Editor 账号',
        role: account.role,
        organizationId: account.organizationId,
        mustChangePassword: account.mustChangePassword,
        mustProvideEmail: account.mustProvideEmail
      }
    }
  }

  private invalidGrant(): SafeError {
    return new SafeError({
      code: 'invalid_grant',
      message: '登录凭据无效或已经过期。',
      statusCode: 401
    })
  }

  private loginRequired(): SafeError {
    return new SafeError({
      code: 'login_required',
      message: '需要登录 AI Editor 产品账号。',
      statusCode: 401
    })
  }
}
