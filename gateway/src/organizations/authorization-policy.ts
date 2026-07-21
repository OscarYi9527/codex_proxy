import type { AccessIdentity } from '../auth/types.js'
import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import {
  OrganizationRepository,
  type InvitationRecord,
  type ManagedAccountRecord,
  type OrganizationRecord,
  type OrganizationScope
} from '../db/repositories/organization-repository.js'

export interface OrganizationAuthorizationContext {
  readonly actor: ManagedAccountRecord
  readonly scope: OrganizationScope
}

function identityMatchesAccount(
  identity: AccessIdentity,
  account: ManagedAccountRecord,
  nowMs: number
): boolean {
  return account.status === 'active' &&
    (account.expiresAt === null || Date.parse(account.expiresAt) > nowMs) &&
    account.role === identity.role &&
    account.organizationId === identity.organizationId &&
    account.version === identity.accountVersion
}

export class OrganizationAuthorizationPolicy {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async context(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null
  ): Promise<OrganizationAuthorizationContext> {
    const actor = await this.repository.getAccount(
      { kind: 'all' },
      identity.accountId
    )
    if (
      !actor ||
      !identityMatchesAccount(identity, actor, this.clock.nowMs()) ||
      actor.role === 'user' ||
      (actor.role === 'level2' && actor.organizationId === null)
    ) {
      await this.denied(
        identity,
        action,
        targetType,
        targetId,
        actor?.organizationId ?? identity.organizationId,
        'role_or_session'
      )
    }
    return {
      actor: actor as ManagedAccountRecord,
      scope: actor?.role === 'level1'
        ? { kind: 'all' }
        : {
            kind: 'organization',
            organizationId: actor?.organizationId as string
          }
    }
  }

  async requireLevel1(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null
  ): Promise<OrganizationAuthorizationContext> {
    const context = await this.context(identity, action, targetType, targetId)
    if (context.actor.role !== 'level1') {
      await this.denied(
        identity,
        action,
        targetType,
        targetId,
        context.actor.organizationId,
        'level1_required'
      )
    }
    return context
  }

  async organization(
    identity: AccessIdentity,
    action: string,
    organizationId: string
  ): Promise<{
    readonly context: OrganizationAuthorizationContext
    readonly organization: OrganizationRecord | null
  }> {
    const context = await this.context(
      identity,
      action,
      'organization',
      organizationId
    )
    const organization = await this.repository.getOrganization(
      context.scope,
      organizationId
    )
    if (!organization && context.actor.role === 'level2') {
      await this.denied(
        identity,
        action,
        'organization',
        organizationId,
        context.actor.organizationId,
        'organization_scope'
      )
    }
    return { context, organization }
  }

  async account(
    identity: AccessIdentity,
    action: string,
    accountId: string
  ): Promise<{
    readonly context: OrganizationAuthorizationContext
    readonly account: ManagedAccountRecord | null
  }> {
    const context = await this.context(identity, action, 'account', accountId)
    const account = await this.repository.getAccount(context.scope, accountId)
    if (
      context.actor.role === 'level2' &&
      (!account || account.role !== 'user')
    ) {
      await this.denied(
        identity,
        action,
        'account',
        accountId,
        context.actor.organizationId,
        account ? 'ordinary_user_required' : 'organization_scope'
      )
    }
    return { context, account }
  }

  async invitation(
    identity: AccessIdentity,
    action: string,
    invitationId: string
  ): Promise<{
    readonly context: OrganizationAuthorizationContext
    readonly invitation: InvitationRecord | null
  }> {
    const context = await this.context(
      identity,
      action,
      'invitation',
      invitationId
    )
    const invitation = await this.repository.getInvitation(
      context.scope,
      invitationId,
      this.clock.now().toISOString()
    )
    if (!invitation && context.actor.role === 'level2') {
      await this.denied(
        identity,
        action,
        'invitation',
        invitationId,
        context.actor.organizationId,
        'organization_scope'
      )
    }
    return { context, invitation }
  }

  async allowed(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null,
    safeMetadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.audit(
      identity,
      action,
      targetType,
      targetId,
      'allowed',
      safeMetadata
    )
  }

  async failed(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null,
    reason: string
  ): Promise<void> {
    await this.audit(
      identity,
      action,
      targetType,
      targetId,
      'failed',
      { reason }
    )
  }

  private async denied(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null,
    organizationId: string | null,
    reason: string
  ): Promise<never> {
    await this.repository.insertAuditEvent({
      id: this.ids.opaque('audit'),
      actorAccountId: identity.accountId,
      organizationId,
      action,
      targetType,
      targetId,
      outcome: 'denied',
      safeMetadata: { reason },
      createdAt: this.clock.now().toISOString()
    })
    throw new SafeError({
      code: 'forbidden',
      message: '没有权限执行此管理操作。',
      statusCode: 403
    })
  }

  private async audit(
    identity: AccessIdentity,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: 'allowed' | 'failed',
    safeMetadata: Record<string, unknown>
  ): Promise<void> {
    await this.repository.insertAuditEvent({
      id: this.ids.opaque('audit'),
      actorAccountId: identity.accountId,
      organizationId: identity.organizationId,
      action,
      targetType,
      targetId,
      outcome,
      safeMetadata,
      createdAt: this.clock.now().toISOString()
    })
  }
}
