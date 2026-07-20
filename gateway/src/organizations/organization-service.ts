import type { Clock } from '../common/clock.js'
import type { KeyedDigest } from '../common/digests.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import type { AccessIdentity, AccountRole } from '../auth/types.js'
import type { AuthRepository } from '../db/repositories/auth-repository.js'
import {
  assertLevel1CanBeChanged,
  requireAccountManager,
  requireLevel1,
  requireOrganizationManager
} from './authorization-policy.js'
import { OrganizationRepository } from '../db/repositories/organization-repository.js'

function invalid(message: string): SafeError {
  return new SafeError({ code: 'invalid_request', message, statusCode: 400 })
}

export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly digest: KeyedDigest,
    private readonly clock: Clock,
    private readonly ids: IdSource,
    private readonly capacityRepository: Pick<AuthRepository, 'getPublicMvpCapacity'>
  ) {}

  async publicMvpCapacity(identity: AccessIdentity) {
    requireLevel1(identity)
    const capacity = await this.capacityRepository.getPublicMvpCapacity()
    return {
      phase: 'public_mvp' as const,
      hardLimit: capacity.hardLimit,
      admittedAccountCount: capacity.admittedAccountCount,
      remainingAccountCount: capacity.longTermCoreReady
        ? null
        : Math.max(0, capacity.hardLimit - capacity.admittedAccountCount),
      longTermCoreReady: capacity.longTermCoreReady,
      account31Blocked: !capacity.longTermCoreReady,
      includesAdministrators: true,
      updatedAt: capacity.updatedAt
    }
  }

  async organizations(identity: AccessIdentity) {
    if (identity.role === 'level2' && identity.organizationId) {
      const organization = await this.repository.findOrganization(identity.organizationId)
      return organization ? [organization] : []
    }
    requireLevel1(identity)
    return this.repository.listOrganizations()
  }

  async createOrganization(identity: AccessIdentity, input: Record<string, unknown>) {
    requireLevel1(identity)
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 240) : ''
    if (!name) throw invalid('组织名称无效。')
    return this.repository.createOrganization({
      id: this.ids.opaque('org'),
      name,
      now: this.clock.now().toISOString()
    })
  }

  async accounts(identity: AccessIdentity) {
    if (identity.role === 'level2' && identity.organizationId) {
      return this.repository.listAccountsForOrganization(identity.organizationId)
    }
    requireLevel1(identity)
    return this.repository.listAccounts()
  }

  async setAccountStatus(identity: AccessIdentity, accountId: string, status: 'active' | 'disabled') {
    await this.repository.inTransaction(async repository => {
      const account = await repository.findAccount(accountId)
      if (!account) {
        throw new SafeError({ code: 'not_found', message: '账号不存在。', statusCode: 404 })
      }
      requireAccountManager(identity, account)
      if (status === 'disabled' && account.status === 'active') {
        assertLevel1CanBeChanged(account, await repository.countActiveLevel1())
      }
      if (!await repository.updateAccountStatus(
        accountId,
        status,
        this.clock.now().toISOString(),
        identity.accountId
      )) {
        throw new SafeError({
          code: 'account_status_conflict',
          message: '账号状态已经变化，请刷新后重试。',
          statusCode: 409,
          retryable: true
        })
      }
    })
  }

  async setAccountRole(
    identity: AccessIdentity,
    accountId: string,
    input: Record<string, unknown>
  ) {
    requireLevel1(identity)
    const role = input.role
    if (!['level1', 'level2', 'user'].includes(String(role))) {
      throw invalid('账号角色无效。')
    }
    return this.repository.inTransaction(async repository => {
      const account = await repository.findAccount(accountId)
      if (!account) {
        throw new SafeError({ code: 'not_found', message: '账号不存在。', statusCode: 404 })
      }
      const targetRole = role as AccountRole
      if (
        account.role === 'level1' &&
        account.status === 'active' &&
        targetRole !== 'level1'
      ) {
        assertLevel1CanBeChanged(account, await repository.countActiveLevel1())
      }

      let organizationId: string | null = null
      if (targetRole !== 'level1') {
        organizationId = typeof input.organizationId === 'string'
          ? input.organizationId.trim()
          : input.organizationId === undefined
            ? account.organizationId
            : null
        if (!organizationId) throw invalid('二级管理员和普通用户必须归属组织。')
        const organization = await repository.findOrganization(organizationId)
        if (!organization) {
          throw new SafeError({ code: 'not_found', message: '组织不存在。', statusCode: 404 })
        }
        if (organization.status !== 'active') {
          throw new SafeError({
            code: 'organization_disabled',
            message: '组织已被禁用。',
            statusCode: 409
          })
        }
      }

      if (!await repository.updateAccountRole(
        accountId,
        targetRole,
        organizationId,
        this.clock.now().toISOString()
      )) {
        throw new SafeError({
          code: 'account_role_conflict',
          message: '账号角色已经变化，请刷新后重试。',
          statusCode: 409,
          retryable: true
        })
      }
      const updated = await repository.findAccount(accountId)
      if (!updated) {
        throw new SafeError({ code: 'not_found', message: '账号不存在。', statusCode: 404 })
      }
      return updated
    })
  }

  async invitations(identity: AccessIdentity) {
    let invitations
    if (identity.role === 'level2' && identity.organizationId) {
      invitations = await this.repository.listInvitations(identity.organizationId)
    } else {
      requireLevel1(identity)
      invitations = await this.repository.listInvitations()
    }
    return invitations.map(invitation => (
      invitation.status === 'active' &&
      Date.parse(invitation.expiresAt) <= this.clock.nowMs()
        ? { ...invitation, status: 'expired' as const }
        : invitation
    ))
  }

  async createInvitation(identity: AccessIdentity, input: Record<string, unknown>) {
    const requestedOrganizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const organizationId = identity.role === 'level2' ? identity.organizationId : requestedOrganizationId
    if (!organizationId) throw invalid('必须指定组织。')
    requireOrganizationManager(identity, organizationId)
    const organization = await this.repository.findOrganization(organizationId)
    if (!organization) {
      throw new SafeError({ code: 'not_found', message: '组织不存在。', statusCode: 404 })
    }
    if (organization.status !== 'active') {
      throw new SafeError({ code: 'organization_disabled', message: '组织已被禁用。', statusCode: 409 })
    }
    const capacity = await this.capacityRepository.getPublicMvpCapacity()
    if (
      !capacity.longTermCoreReady &&
      capacity.admittedAccountCount >= capacity.hardLimit
    ) {
      throw new SafeError({
        code: 'public_mvp_capacity_reached',
        message: '公网 MVP 已达到 30 个产品账号上限，当前不能继续生成邀请码。',
        statusCode: 409
      })
    }
    const expiresAt = typeof input.expiresAt === 'string' ? input.expiresAt : ''
    const maxUses = Number(input.maxUses)
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.clock.nowMs()) {
      throw invalid('邀请码有效期无效。')
    }
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) {
      throw invalid('邀请码使用次数无效。')
    }
    const code = this.ids.secret(24)
    await this.repository.createInvitation({
      id: this.ids.opaque('inv'),
      organizationId,
      codeDigest: this.digest.digest('invitation', code),
      createdBy: identity.accountId,
      expiresAt,
      maxUses,
      now: this.clock.now().toISOString()
    })
    return { code, expiresAt, maxUses, organizationId }
  }

  async revokeInvitation(identity: AccessIdentity, invitationId: string): Promise<void> {
    const invitations = await this.invitations(identity)
    const invitation = invitations.find(candidate => candidate.id === invitationId)
    if (!invitation) {
      throw new SafeError({ code: 'not_found', message: '邀请码不存在。', statusCode: 404 })
    }
    requireOrganizationManager(identity, invitation.organizationId)
    if (invitation.status !== 'active') {
      throw new SafeError({ code: 'invitation_not_active', message: '邀请码已失效。', statusCode: 409 })
    }
    const revoked = await this.repository.revokeInvitation(
      invitationId,
      this.clock.now().toISOString(),
      identity.accountId
    )
    if (!revoked) {
      throw new SafeError({ code: 'invitation_not_active', message: '邀请码已失效。', statusCode: 409 })
    }
  }
}
