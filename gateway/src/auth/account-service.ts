import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import { AuthRepository } from '../db/repositories/auth-repository.js'
import { PasswordService } from './password-service.js'
import { TokenService } from './token-service.js'
import type { AccessIdentity, IssuedTokenSet, ProductAccount } from './types.js'
import type { CreditService } from '../credits/credit-service.js'
import { percentage } from '../credits/decimal.js'

const TEMPORARY_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000

function validateEmail(value: string | undefined): string | null {
  if (value === undefined) return null
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

function accountState(account: ProductAccount, nowMs: number):
  'ready' | 'account_unavailable' | 'password_change_required' {
  if (
    account.status !== 'active' ||
    account.organizationStatus === 'disabled' ||
    (account.expiresAt !== null && Date.parse(account.expiresAt) <= nowMs)
  ) {
    return 'account_unavailable'
  }
  if (account.mustChangePassword || account.mustProvideEmail) {
    return 'password_change_required'
  }
  return 'ready'
}

export class AccountService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly clock: Clock,
    private readonly credits?: CreditService
  ) {}

  async status(identity: AccessIdentity, currentModel: string | null): Promise<{
    state: 'ready' | 'account_unavailable' | 'password_change_required'
    checkedAt: string
      accountVersion: number
    safeSummary: {
      accountDisplay: string
      currentModel: string | null
      availableCredits: string
      usedCreditsPercent: string
    }
    actions: Array<'openAccount'>
  }> {
    const account = await this.requireAccount(identity.accountId)
    const state = accountState(account, this.clock.nowMs())
    const credits = this.credits
      ? await this.credits.accountCredits(identity.accountId)
      : {
          allocated: '0.000000',
          settled: '0.000000',
          available: '0.000000'
        }
    return {
      state,
      checkedAt: this.clock.now().toISOString(),
      accountVersion: account.version,
      safeSummary: {
        accountDisplay: account.email || account.loginName || 'AI Editor 账号',
        currentModel,
        availableCredits: credits.available,
        usedCreditsPercent: percentage(credits.settled, credits.allocated)
      },
      actions: state === 'ready' ? [] : ['openAccount']
    }
  }

  async me(identity: AccessIdentity): Promise<{
    account: {
      id: string
      email: string | null
      loginName: string | null
      role: ProductAccount['role']
      status: ProductAccount['status']
      expiresAt: string | null
      organization: { id: string; name: string } | null
      mustChangePassword: boolean
      mustProvideEmail: boolean
    }
    credits: {
      periodStart: string | null
      periodEnd: string | null
      allocated: string
      settled: string
      available: string
    }
  }> {
    const account = await this.requireAccount(identity.accountId)
    const credits = this.credits
      ? await this.credits.accountCredits(identity.accountId)
      : {
          periodStart: null,
          periodEnd: null,
          allocated: '0.000000',
          settled: '0.000000',
          available: '0.000000'
        }
    return {
      account: {
        id: account.id,
        email: account.email,
        loginName: account.loginName,
        role: account.role,
        status: account.status,
        expiresAt: account.expiresAt,
        organization: account.organizationId && account.organizationName
          ? { id: account.organizationId, name: account.organizationName }
          : null,
        mustChangePassword: account.mustChangePassword,
        mustProvideEmail: account.mustProvideEmail
      },
      credits
    }
  }

  async changePassword(options: {
    identity: AccessIdentity
    currentPassword: string
    newPassword: string
    email?: string
  }): Promise<IssuedTokenSet> {
    const account = await this.requireAccount(options.identity.accountId)
    const credential = await this.repository.getPasswordCredential(account.id)
    if (
      !credential ||
      !await this.passwords.verify(credential.passwordHash, options.currentPassword)
    ) {
      throw new SafeError({
        code: 'invalid_credentials',
        message: '当前密码错误。',
        statusCode: 401
      })
    }
    const email = validateEmail(options.email)
    if (account.mustProvideEmail && !email) {
      throw new SafeError({
        code: 'email_required',
        message: '首次登录必须填写邮箱。',
        statusCode: 400
      })
    }
    const passwordHash = await this.passwords.hash(options.newPassword)
    return this.repository.inTransaction(async repository => {
      const passwordVersion = await repository.replacePassword({
        accountId: account.id,
        passwordHash,
        email,
        now: this.clock.now().toISOString()
      })
      await repository.revokeOtherDeviceSessions(
        account.id,
        options.identity.deviceSessionId,
        this.clock.now().toISOString()
      )
      const updated = await repository.findAccountById(account.id)
      if (!updated) throw new Error('Updated account is missing')
      return this.tokens.reissueAfterPasswordChange({
        repository,
        account: updated,
        passwordVersion,
        deviceSessionId: options.identity.deviceSessionId
      })
    })
  }

  async logout(identity: AccessIdentity): Promise<void> {
    await this.repository.inTransaction(repository =>
      repository.revokeDeviceSession(
        identity.deviceSessionId,
        this.clock.now().toISOString(),
        'logout'
      )
    )
  }

  async issueTemporaryPassword(
    identity: AccessIdentity,
    accountId: string
  ): Promise<{
    temporaryPassword: string
    mustChangePassword: true
    expiresAt: string
  }> {
    if (identity.role !== 'level1') {
      throw new SafeError({
        code: 'admin_forbidden',
        message: 'Only Level 1 administrators can reset passwords.',
        statusCode: 403
      })
    }
    await this.requireAccount(accountId)
    const temporaryPassword = this.passwords.generateTemporaryPassword()
    const passwordHash = await this.passwords.hash(temporaryPassword)
    const now = this.clock.now().toISOString()
    const expiresAt = new Date(this.clock.nowMs() + TEMPORARY_PASSWORD_TTL_MS).toISOString()
    await this.repository.inTransaction(async repository => {
      await repository.replacePasswordWithTemporaryCredential({
        accountId,
        passwordHash,
        expiresAt,
        now
      })
      await repository.revokeAllDeviceSessions(accountId, now, 'temporary_password_issued')
    })
    return {
      temporaryPassword,
      mustChangePassword: true,
      expiresAt
    }
  }

  async devices(identity: AccessIdentity): Promise<Array<{
    id: string
    name: string
    platform: string
    createdAt: string
    lastUsedAt: string
    expiresAt: string
    revokedAt: string | null
    current: boolean
  }>> {
    const devices = await this.repository.listDevices(identity.accountId)
    return devices.map(device => ({
      ...device,
      current: device.id === identity.deviceSessionId
    }))
  }

  async revokeDevice(
    identity: AccessIdentity,
    sessionId: string,
    confirmCurrent: boolean
  ): Promise<void> {
    if (sessionId === identity.deviceSessionId && !confirmCurrent) {
      throw new SafeError({
        code: 'current_device_confirmation_required',
        message: '撤销当前设备需要明确确认。',
        statusCode: 400
      })
    }
    const revoked = await this.repository.inTransaction(repository =>
      repository.revokeOwnedDeviceSession(
        identity.accountId,
        sessionId,
        this.clock.now().toISOString(),
        'user_revoked'
      )
    )
    if (!revoked) {
      throw new SafeError({
        code: 'device_not_found',
        message: '未找到当前账号的设备会话。',
        statusCode: 404
      })
    }
  }

  private async requireAccount(accountId: string): Promise<ProductAccount> {
    const account = await this.repository.findAccountById(accountId)
    if (!account) {
      throw new SafeError({
        code: 'login_required',
        message: '需要登录 AI Editor 产品账号。',
        statusCode: 401
      })
    }
    return account
  }
}
