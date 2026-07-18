import type { Clock } from '../common/clock.js'
import type { KeyedDigest } from '../common/digests.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import type { AccessIdentity } from '../auth/types.js'
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
    private readonly ids: IdSource
  ) {}

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
    const account = await this.repository.findAccount(accountId)
    if (!account) throw new SafeError({ code: 'not_found', message: '账号不存在。', statusCode: 404 })
    requireAccountManager(identity, account)
    if (status === 'disabled') {
      assertLevel1CanBeChanged(account, await this.repository.countActiveLevel1())
    }
    await this.repository.updateAccountStatus(accountId, status, this.clock.now().toISOString(), identity.accountId)
  }

  async invitations(identity: AccessIdentity) {
    if (identity.role === 'level2' && identity.organizationId) {
      return this.repository.listInvitations(identity.organizationId)
    }
    requireLevel1(identity)
    return this.repository.listInvitations()
  }

  async createInvitation(identity: AccessIdentity, input: Record<string, unknown>) {
    const requestedOrganizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const organizationId = identity.role === 'level2' ? identity.organizationId : requestedOrganizationId
    if (!organizationId) throw invalid('必须指定组织。')
    requireOrganizationManager(identity, organizationId)
    if (!await this.repository.findOrganization(organizationId)) {
      throw new SafeError({ code: 'not_found', message: '组织不存在。', statusCode: 404 })
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
}
