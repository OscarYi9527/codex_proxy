import type { AccessIdentity, AccountRole } from '../auth/types.js'
import { PasswordService } from '../auth/password-service.js'
import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  OrganizationRepository,
  type ManagedAccountRecord,
  type OrganizationRecord,
  type OrganizationScope
} from '../db/repositories/organization-repository.js'
import { OrganizationAuthorizationPolicy } from './authorization-policy.js'

const DEFAULT_BILLING_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_AUDIT_RETENTION_DAYS = 30
const TEMPORARY_PASSWORD_TTL_MS = 60 * 60_000

function assertAllowedFields(
  body: Record<string, unknown>,
  allowed: readonly string[]
): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    throw invalidRequest('请求包含不支持的字段。')
  }
}

function text(
  value: unknown,
  field: string,
  maximumLength: number,
  required = true
): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw invalidRequest(`${field} 必须是字符串。`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength) {
    throw invalidRequest(`${field} 长度无效。`)
  }
  return normalized
}

function status(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') {
    throw invalidRequest('status 必须是 active 或 disabled。')
  }
  return value
}

function retentionDays(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 7 || Number(value) > 180) {
    throw invalidRequest('auditRetentionDays 必须是 7 到 180 的整数。')
  }
  return Number(value)
}

function billingTimezone(value: unknown): string {
  const timezone = text(value, 'billingTimezone', 80) as string
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw invalidRequest('billingTimezone 必须是有效的 IANA 时区。')
  }
  return timezone
}

function email(value: unknown): string {
  const normalized = text(value, 'email', 320) as string
  const lower = normalized.toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
    throw invalidRequest('email 格式无效。')
  }
  return lower
}

function nullableInstant(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidRequest(`${field} 必须是 UTC 时间或 null。`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw invalidRequest(`${field} 时间格式无效。`)
  return new Date(parsed).toISOString()
}

function accountRole(value: unknown): AccountRole {
  if (!['level1', 'level2', 'user'].includes(String(value))) {
    throw invalidRequest('role 必须是 level1、level2 或 user。')
  }
  return value as AccountRole
}

function invalidRequest(message: string): SafeError {
  return new SafeError({
    code: 'invalid_request',
    message,
    statusCode: 400
  })
}

function accountNotFound(): SafeError {
  return new SafeError({
    code: 'account_not_found',
    message: '未找到账号。',
    statusCode: 404
  })
}

function organizationNotFound(): SafeError {
  return new SafeError({
    code: 'organization_not_found',
    message: '未找到组织。',
    statusCode: 404
  })
}

function lastLevel1Protected(): SafeError {
  return new SafeError({
    code: 'last_level1_protected',
    message: '必须至少保留一个有效的一级管理员。',
    statusCode: 409
  })
}

export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly policy: OrganizationAuthorizationPolicy,
    private readonly passwords: PasswordService,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async listOrganizations(identity: AccessIdentity): Promise<{
    organizations: OrganizationRecord[]
  }> {
    const context = await this.policy.context(
      identity,
      'organization.list',
      'organization',
      null
    )
    return {
      organizations: await this.repository.listOrganizations(context.scope)
    }
  }

  async getOrganization(
    identity: AccessIdentity,
    organizationId: string
  ): Promise<OrganizationRecord> {
    const { organization } = await this.policy.organization(
      identity,
      'organization.read',
      organizationId
    )
    if (!organization) throw organizationNotFound()
    return organization
  }

  async createOrganization(
    identity: AccessIdentity,
    body: Record<string, unknown>
  ): Promise<OrganizationRecord> {
    await this.policy.requireLevel1(
      identity,
      'organization.create',
      'organization',
      null
    )
    assertAllowedFields(body, [
      'name',
      'status',
      'billingTimezone',
      'auditRetentionDays'
    ])
    const name = text(body['name'], 'name', 240) as string
    if (await this.repository.organizationNameExists(name)) {
      throw new SafeError({
        code: 'organization_name_conflict',
        message: '组织名称已存在。',
        statusCode: 409
      })
    }
    const now = this.clock.now().toISOString()
    const organization: OrganizationRecord = {
      id: this.ids.opaque('org'),
      name,
      status: body['status'] === undefined ? 'active' : status(body['status']),
      billingTimezone: body['billingTimezone'] === undefined
        ? DEFAULT_BILLING_TIMEZONE
        : billingTimezone(body['billingTimezone']),
      auditRetentionDays: body['auditRetentionDays'] === undefined
        ? DEFAULT_AUDIT_RETENTION_DAYS
        : retentionDays(body['auditRetentionDays']),
      createdAt: now,
      updatedAt: now,
      version: 1
    }
    await this.repository.insertOrganization(organization)
    await this.policy.allowed(
      identity,
      'organization.create',
      'organization',
      organization.id,
      { status: organization.status }
    )
    return organization
  }

  async updateOrganization(
    identity: AccessIdentity,
    organizationId: string,
    body: Record<string, unknown>
  ): Promise<OrganizationRecord> {
    const { organization } = await this.policy.organization(
      identity,
      'organization.update',
      organizationId
    )
    await this.policy.requireLevel1(
      identity,
      'organization.update',
      'organization',
      organizationId
    )
    if (!organization) throw organizationNotFound()
    assertAllowedFields(body, [
      'name',
      'status',
      'billingTimezone',
      'auditRetentionDays'
    ])
    if (Object.keys(body).length === 0) throw invalidRequest('至少需要一个更新字段。')
    const patch = {
      ...(body['name'] === undefined
        ? {}
        : { name: text(body['name'], 'name', 240) as string }),
      ...(body['status'] === undefined ? {} : { status: status(body['status']) }),
      ...(body['billingTimezone'] === undefined
        ? {}
        : { billingTimezone: billingTimezone(body['billingTimezone']) }),
      ...(body['auditRetentionDays'] === undefined
        ? {}
        : { auditRetentionDays: retentionDays(body['auditRetentionDays']) }),
      updatedAt: this.clock.now().toISOString()
    }
    if (
      patch.name !== undefined &&
      await this.repository.organizationNameExists(patch.name, organizationId)
    ) {
      throw new SafeError({
        code: 'organization_name_conflict',
        message: '组织名称已存在。',
        statusCode: 409
      })
    }
    try {
      await this.repository.inTransaction(async repository => {
        if (patch.status === 'disabled') {
          await repository.serializeOrganization(organizationId, patch.updatedAt)
          await repository.serializeLevel1Invariant(patch.updatedAt)
        }
        if (!await repository.updateOrganization(
          { kind: 'all' },
          organizationId,
          patch
        )) {
          throw organizationNotFound()
        }
        if (
          patch.status === 'disabled' &&
          await repository.countEffectiveLevel1(patch.updatedAt) === 0
        ) {
          throw lastLevel1Protected()
        }
      })
    } catch (error) {
      await this.auditLastLevel1Failure(
        error,
        identity,
        'organization.update',
        'organization',
        organizationId
      )
      throw error
    }
    await this.policy.allowed(
      identity,
      'organization.update',
      'organization',
      organizationId,
      { fields: Object.keys(body) }
    )
    return await this.repository.getOrganization(
      { kind: 'all' },
      organizationId
    ) as OrganizationRecord
  }

  async listAccounts(identity: AccessIdentity): Promise<{
    accounts: ManagedAccountRecord[]
  }> {
    const context = await this.policy.context(
      identity,
      'account.list',
      'account',
      null
    )
    return {
      accounts: await this.repository.listAccounts(context.scope, {
        ordinaryUsersOnly: context.actor.role === 'level2'
      })
    }
  }

  async getAccount(
    identity: AccessIdentity,
    accountId: string
  ): Promise<ManagedAccountRecord> {
    const { account } = await this.policy.account(
      identity,
      'account.read',
      accountId
    )
    if (!account) throw accountNotFound()
    return account
  }

  async updateAccount(
    identity: AccessIdentity,
    accountId: string,
    body: Record<string, unknown>
  ): Promise<ManagedAccountRecord> {
    const { context, account } = await this.policy.account(
      identity,
      'account.update',
      accountId
    )
    if (!account) throw accountNotFound()
    assertAllowedFields(body, ['email', 'organizationId', 'expiresAt'])
    if (Object.keys(body).length === 0) throw invalidRequest('至少需要一个更新字段。')
    if (body['organizationId'] !== undefined && context.actor.role !== 'level1') {
      await this.policy.requireLevel1(
        identity,
        'account.update',
        'account',
        accountId
      )
    }
    const nextEmail = body['email'] === undefined ? undefined : email(body['email'])
    const nextExpiresAt = body['expiresAt'] === undefined
      ? undefined
      : nullableInstant(body['expiresAt'], 'expiresAt')
    const nextOrganizationId = body['organizationId'] === undefined
      ? undefined
      : body['organizationId'] === null
        ? null
        : text(body['organizationId'], 'organizationId', 80) as string
    if (
      nextOrganizationId === null &&
      account.role !== 'level1'
    ) {
      throw invalidRequest('二级管理员和普通用户必须属于一个组织。')
    }
    if (nextOrganizationId !== undefined && nextOrganizationId !== null) {
      await this.requireActiveOrganization(nextOrganizationId)
    }
    if (
      nextEmail !== undefined &&
      await this.repository.emailExists(nextEmail, accountId)
    ) {
      throw new SafeError({
        code: 'email_already_registered',
        message: '该邮箱已被其他账号使用。',
        statusCode: 409
      })
    }
    const changed = (nextEmail !== undefined && nextEmail !== account.email) ||
      (nextExpiresAt !== undefined && nextExpiresAt !== account.expiresAt) ||
      (
        nextOrganizationId !== undefined &&
        nextOrganizationId !== account.organizationId
      )
    if (!changed) {
      await this.policy.allowed(
        identity,
        'account.update',
        'account',
        accountId,
        { fields: [], unchanged: true }
      )
      return account
    }
    const now = this.clock.now().toISOString()
    try {
      await this.repository.inTransaction(async repository => {
        if (nextOrganizationId !== undefined && nextOrganizationId !== null) {
          await repository.serializeOrganization(nextOrganizationId, now)
          const destination = await repository.getOrganization(
            { kind: 'all' },
            nextOrganizationId
          )
          if (!destination || destination.status !== 'active') {
            throw new SafeError({
              code: 'organization_invalid',
              message: '目标组织不存在或已禁用。',
              statusCode: 409
            })
          }
        }
        if (account.role === 'level1' && nextExpiresAt !== undefined) {
          await repository.serializeLevel1Invariant(now)
        }
        const updated = await repository.updateAccount(
          context.scope,
          accountId,
          {
            ...(nextEmail === undefined ? {} : { email: nextEmail }),
            ...(nextExpiresAt === undefined ? {} : { expiresAt: nextExpiresAt }),
            ...(nextOrganizationId === undefined
              ? {}
              : { organizationId: nextOrganizationId }),
            updatedAt: now
          },
          { ordinaryUsersOnly: context.actor.role === 'level2' }
        )
        if (!updated) throw this.concurrentAccountChange(context.scope)
        if (
          account.role === 'level1' &&
          nextExpiresAt !== undefined &&
          await repository.countEffectiveLevel1(now) === 0
        ) {
          throw lastLevel1Protected()
        }
      })
    } catch (error) {
      await this.auditLastLevel1Failure(
        error,
        identity,
        'account.update',
        'account',
        accountId
      )
      throw error
    }
    await this.policy.allowed(
      identity,
      'account.update',
      'account',
      accountId,
      { fields: Object.keys(body) }
    )
    return await this.requireUpdatedAccount(accountId)
  }

  async enableAccount(
    identity: AccessIdentity,
    accountId: string
  ): Promise<ManagedAccountRecord> {
    return this.setAccountStatus(identity, accountId, 'active', 'account.enable')
  }

  async disableAccount(
    identity: AccessIdentity,
    accountId: string
  ): Promise<ManagedAccountRecord> {
    return this.setAccountStatus(identity, accountId, 'disabled', 'account.disable')
  }

  async deleteAccount(identity: AccessIdentity, accountId: string): Promise<void> {
    await this.setAccountStatus(identity, accountId, 'disabled', 'account.delete')
  }

  async updateRole(
    identity: AccessIdentity,
    accountId: string,
    body: Record<string, unknown>
  ): Promise<ManagedAccountRecord> {
    await this.policy.requireLevel1(
      identity,
      'account.role.update',
      'account',
      accountId
    )
    const account = await this.repository.getAccount({ kind: 'all' }, accountId)
    if (!account) throw accountNotFound()
    assertAllowedFields(body, ['role'])
    const role = accountRole(body['role'])
    if (role !== 'level1' && account.organizationId === null) {
      throw invalidRequest('降级后的账号必须属于一个组织。')
    }
    if (role === account.role) {
      await this.policy.allowed(
        identity,
        'account.role.update',
        'account',
        accountId,
        { previousRole: account.role, role, unchanged: true }
      )
      return account
    }
    const now = this.clock.now().toISOString()
    try {
      await this.repository.inTransaction(async repository => {
        if (account.role === 'level1' && role !== 'level1') {
          await repository.serializeLevel1Invariant(now)
        }
        if (!await repository.updateAccount(
          { kind: 'all' },
          accountId,
          { role, updatedAt: now }
        )) {
          throw accountNotFound()
        }
        if (
          account.role === 'level1' &&
          role !== 'level1' &&
          await repository.countEffectiveLevel1(now) === 0
        ) {
          throw lastLevel1Protected()
        }
      })
    } catch (error) {
      await this.auditLastLevel1Failure(
        error,
        identity,
        'account.role.update',
        'account',
        accountId
      )
      throw error
    }
    await this.policy.allowed(
      identity,
      'account.role.update',
      'account',
      accountId,
      { previousRole: account.role, role }
    )
    return await this.requireUpdatedAccount(accountId)
  }

  async issueTemporaryPassword(
    identity: AccessIdentity,
    accountId: string
  ): Promise<{
    temporaryPassword: string
    mustChangePassword: true
    expiresAt: string
  }> {
    await this.policy.requireLevel1(
      identity,
      'account.temporary_password.issue',
      'account',
      accountId
    )
    if (!await this.repository.getAccount({ kind: 'all' }, accountId)) {
      throw accountNotFound()
    }
    const temporaryPassword = this.passwords.generateTemporaryPassword()
    const passwordHash = await this.passwords.hash(temporaryPassword)
    const now = this.clock.now().toISOString()
    const expiresAt = new Date(
      this.clock.nowMs() + TEMPORARY_PASSWORD_TTL_MS
    ).toISOString()
    if (!await this.repository.inTransaction(repository =>
      repository.setTemporaryPassword({
        scope: { kind: 'all' },
        accountId,
        passwordHash,
        now,
        expiresAt
      })
    )) {
      throw accountNotFound()
    }
    await this.policy.allowed(
      identity,
      'account.temporary_password.issue',
      'account',
      accountId,
      { expiresAt }
    )
    return { temporaryPassword, mustChangePassword: true, expiresAt }
  }

  private async setAccountStatus(
    identity: AccessIdentity,
    accountId: string,
    nextStatus: 'active' | 'disabled',
    action: string
  ): Promise<ManagedAccountRecord> {
    const { context, account } = await this.policy.account(
      identity,
      action,
      accountId
    )
    if (!account) throw accountNotFound()
    const now = this.clock.now().toISOString()
    if (
      nextStatus === 'active' &&
      account.expiresAt !== null &&
      account.expiresAt <= now
    ) {
      throw new SafeError({
        code: 'account_expired',
        message: '请先更新账号到期时间再启用。',
        statusCode: 409
      })
    }
    if (account.status === nextStatus) {
      await this.policy.allowed(identity, action, 'account', accountId, {
        status: nextStatus,
        softDelete: action === 'account.delete',
        unchanged: true
      })
      return account
    }
    try {
      await this.repository.inTransaction(async repository => {
        if (account.role === 'level1' && nextStatus === 'disabled') {
          await repository.serializeLevel1Invariant(now)
        }
        const updated = await repository.updateAccount(
          context.scope,
          accountId,
          {
            status: nextStatus,
            updatedAt: now,
            disabledAt: nextStatus === 'disabled' ? now : null,
            disabledBy: nextStatus === 'disabled' ? identity.accountId : null
          },
          { ordinaryUsersOnly: context.actor.role === 'level2' }
        )
        if (!updated) throw this.concurrentAccountChange(context.scope)
        if (
          account.role === 'level1' &&
          nextStatus === 'disabled' &&
          await repository.countEffectiveLevel1(now) === 0
        ) {
          throw lastLevel1Protected()
        }
      })
    } catch (error) {
      await this.auditLastLevel1Failure(
        error,
        identity,
        action,
        'account',
        accountId
      )
      throw error
    }
    await this.policy.allowed(identity, action, 'account', accountId, {
      status: nextStatus,
      softDelete: action === 'account.delete'
    })
    return await this.requireUpdatedAccount(accountId)
  }

  private async requireActiveOrganization(
    organizationId: string
  ): Promise<OrganizationRecord> {
    const organization = await this.repository.getOrganization(
      { kind: 'all' },
      organizationId
    )
    if (!organization || organization.status !== 'active') {
      throw new SafeError({
        code: 'organization_invalid',
        message: '目标组织不存在或已禁用。',
        statusCode: 409
      })
    }
    return organization
  }

  private async requireUpdatedAccount(
    accountId: string
  ): Promise<ManagedAccountRecord> {
    const account = await this.repository.getAccount({ kind: 'all' }, accountId)
    if (!account) throw accountNotFound()
    return account
  }

  private concurrentAccountChange(scope: OrganizationScope): SafeError {
    return new SafeError({
      code: scope.kind === 'organization' ? 'forbidden' : 'account_state_changed',
      message: scope.kind === 'organization'
        ? '没有权限执行此管理操作。'
        : '账号状态已变化，请刷新后重试。',
      statusCode: scope.kind === 'organization' ? 403 : 409,
      retryable: scope.kind === 'all'
    })
  }

  private async auditLastLevel1Failure(
    error: unknown,
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string
  ): Promise<void> {
    if (error instanceof SafeError && error.code === 'last_level1_protected') {
      await this.policy.failed(
        identity,
        action,
        targetType,
        targetId,
        error.code
      )
    }
  }
}
