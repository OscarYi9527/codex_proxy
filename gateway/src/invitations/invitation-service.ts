import type { AccessIdentity } from '../auth/types.js'
import type { Clock } from '../common/clock.js'
import type { KeyedDigest } from '../common/digests.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  OrganizationRepository,
  type InvitationRecord
} from '../db/repositories/organization-repository.js'
import { OrganizationAuthorizationPolicy } from '../organizations/authorization-policy.js'

const MAX_INVITATION_USES = 10_000

function invalidRequest(message: string): SafeError {
  return new SafeError({
    code: 'invalid_request',
    message,
    statusCode: 400
  })
}

function organizationId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) {
    throw invalidRequest('organizationId 无效。')
  }
  return value.trim()
}

function expiration(value: unknown, nowMs: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidRequest('expiresAt 是必填的 UTC 时间。')
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || parsed <= nowMs) {
    throw invalidRequest('expiresAt 必须是未来时间。')
  }
  return new Date(parsed).toISOString()
}

function maxUses(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_INVITATION_USES
  ) {
    throw invalidRequest(`maxUses 必须是 1 到 ${MAX_INVITATION_USES} 的整数。`)
  }
  return Number(value)
}

function invitationNotFound(): SafeError {
  return new SafeError({
    code: 'invitation_not_found',
    message: '未找到邀请码记录。',
    statusCode: 404
  })
}

export class InvitationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly policy: OrganizationAuthorizationPolicy,
    private readonly digest: KeyedDigest,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async list(identity: AccessIdentity): Promise<{ invitations: InvitationRecord[] }> {
    const context = await this.policy.context(
      identity,
      'invitation.list',
      'invitation',
      null
    )
    return {
      invitations: await this.repository.listInvitations(
        context.scope,
        this.clock.now().toISOString()
      )
    }
  }

  async create(
    identity: AccessIdentity,
    body: Record<string, unknown>
  ): Promise<InvitationRecord & { code: string }> {
    const context = await this.policy.context(
      identity,
      'invitation.create',
      'invitation',
      null
    )
    if (
      Object.keys(body).some(key =>
        !['organizationId', 'expiresAt', 'maxUses'].includes(key)
      )
    ) {
      throw invalidRequest('请求包含不支持的字段。')
    }
    const targetOrganizationId = body['organizationId'] === undefined &&
      context.actor.role === 'level2'
      ? context.actor.organizationId as string
      : organizationId(body['organizationId'])
    const { organization } = await this.policy.organization(
      identity,
      'invitation.create',
      targetOrganizationId
    )
    if (!organization) {
      throw new SafeError({
        code: 'organization_not_found',
        message: '未找到组织。',
        statusCode: 404
      })
    }
    if (organization.status !== 'active') {
      throw new SafeError({
        code: 'organization_disabled',
        message: '已禁用的组织不能创建邀请码。',
        statusCode: 409
      })
    }
    const expiresAt = expiration(body['expiresAt'], this.clock.nowMs())
    const allowedUses = maxUses(body['maxUses'])
    const now = this.clock.now().toISOString()
    const code = this.ids.secret(32)
    const record: InvitationRecord = {
      id: this.ids.opaque('inv'),
      organizationId: targetOrganizationId,
      createdBy: identity.accountId,
      expiresAt,
      maxUses: allowedUses,
      useCount: 0,
      status: 'active',
      createdAt: now,
      revokedAt: null,
      revokedBy: null
    }
    await this.repository.inTransaction(async repository => {
      await repository.serializeOrganization(record.organizationId, now)
      const currentOrganization = await repository.getOrganization(
        context.scope,
        record.organizationId
      )
      if (!currentOrganization || currentOrganization.status !== 'active') {
        throw new SafeError({
          code: 'organization_disabled',
          message: '已禁用的组织不能创建邀请码。',
          statusCode: 409
        })
      }
      await repository.insertInvitation({
        id: record.id,
        organizationId: record.organizationId,
        codeDigest: this.digest.digest('invitation', code),
        createdBy: record.createdBy,
        expiresAt: record.expiresAt,
        maxUses: record.maxUses,
        createdAt: record.createdAt
      })
    })
    await this.policy.allowed(
      identity,
      'invitation.create',
      'invitation',
      record.id,
      {
        organizationId: record.organizationId,
        expiresAt: record.expiresAt,
        maxUses: record.maxUses
      }
    )
    return { ...record, code }
  }

  async revoke(
    identity: AccessIdentity,
    invitationId: string
  ): Promise<InvitationRecord> {
    const { context, invitation } = await this.policy.invitation(
      identity,
      'invitation.revoke',
      invitationId
    )
    if (!invitation) throw invitationNotFound()
    if (invitation.status === 'revoked') {
      await this.policy.allowed(
        identity,
        'invitation.revoke',
        'invitation',
        invitationId,
        { unchanged: true }
      )
      return invitation
    }
    if (invitation.status !== 'active') {
      throw new SafeError({
        code: 'invitation_not_active',
        message: '邀请码已过期或已用尽。',
        statusCode: 409
      })
    }
    const now = this.clock.now().toISOString()
    if (!await this.repository.revokeInvitation({
      scope: context.scope,
      invitationId,
      revokedAt: now,
      revokedBy: identity.accountId
    })) {
      throw new SafeError({
        code: 'invitation_state_changed',
        message: '邀请码状态已变化，请刷新后重试。',
        statusCode: 409,
        retryable: true
      })
    }
    await this.policy.allowed(
      identity,
      'invitation.revoke',
      'invitation',
      invitationId
    )
    return await this.repository.getInvitation(
      context.scope,
      invitationId,
      now
    ) as InvitationRecord
  }
}
