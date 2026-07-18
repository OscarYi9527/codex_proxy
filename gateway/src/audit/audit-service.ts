import type { AccessIdentity } from '../auth/types.js'
import type { Clock } from '../common/clock.js'
import { SafeError } from '../common/errors.js'
import type { IdSource } from '../common/ids.js'
import { redactValue } from '../common/redaction.js'
import {
  AuditRepository,
  type AdminAuditEventRecord,
  type ConversationAuditRecord
} from '../db/repositories/audit-repository.js'
import {
  CONVERSATION_REDACTION_VERSION,
  extractUserText,
  sanitizeConversationText
} from './conversation-sanitizer.js'

const DAY_MS = 86_400_000
const forbiddenMetadataKey =
  /(?:body|content|prompt|response|text|reasoning|tool|password|token|secret|credential|auth)/i

function forbidden(): SafeError {
  return new SafeError({
    code: 'forbidden',
    message: '无权查看该审计记录。',
    statusCode: 403
  })
}

function validTokenCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]'
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' ? value.slice(0, 240) : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeMetadata(item, depth + 1))
  }
  if (!value || typeof value !== 'object') return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !forbiddenMetadataKey.test(key))
      .slice(0, 30)
      .map(([key, item]) => [key.slice(0, 80), sanitizeMetadata(item, depth + 1)])
      .filter(([, item]) => item !== undefined)
  )
}

function safeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const redacted = redactValue(sanitizeMetadata(value || {}))
  const record = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {}
  const serialized = JSON.stringify(record)
  return serialized.length <= 8_192 ? record : { truncated: true }
}

export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async recordConversation(input: {
    identity: AccessIdentity
    turnId: string
    modelId: string
    requestBody: Record<string, unknown>
    assistantText?: string | null
    inputTokens?: number
    outputTokens?: number
  }): Promise<ConversationAuditRecord | null> {
    if (!input.identity.organizationId) return null
    const retentionDays = await this.repository.organizationRetentionDays(
      input.identity.organizationId
    )
    if (retentionDays === null) return null
    const createdAt = this.clock.now().toISOString()
    const record: ConversationAuditRecord = {
      id: this.ids.opaque('audit'),
      turnId: input.turnId,
      accountId: input.identity.accountId,
      organizationId: input.identity.organizationId,
      modelId: input.modelId.slice(0, 240),
      userText: extractUserText(input.requestBody),
      assistantText: input.assistantText
        ? sanitizeConversationText(input.assistantText)
        : null,
      inputTokens: validTokenCount(input.inputTokens),
      outputTokens: validTokenCount(input.outputTokens),
      createdAt,
      bodyExpiresAt: new Date(
        this.clock.nowMs() + retentionDays * DAY_MS
      ).toISOString(),
      bodyDeletedAt: null,
      redactionVersion: CONVERSATION_REDACTION_VERSION
    }
    await this.repository.insertConversation(record)
    return record
  }

  async conversations(
    identity: AccessIdentity,
    query: { organizationId?: string; accountId?: string; limit?: number }
  ) {
    this.requireAdministrator(identity)
    const organizationId = identity.role === 'level2'
      ? identity.organizationId || undefined
      : query.organizationId
    return {
      conversations: await this.repository.listConversations({
        ...(organizationId ? { organizationId } : {}),
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.limit ? { limit: query.limit } : {})
      })
    }
  }

  async conversation(identity: AccessIdentity, auditId: string) {
    const record = await this.repository.findConversation(auditId)
    if (!record) {
      await this.recordAdminEvent(identity, {
        organizationId: identity.organizationId,
        action: 'audit.conversation.view',
        targetType: 'conversation_audit',
        targetId: auditId,
        outcome: 'failed',
        errorCode: 'not_found'
      })
      throw new SafeError({
        code: 'not_found',
        message: '审计记录不存在。',
        statusCode: 404
      })
    }
    if (
      identity.role === 'user' ||
      (identity.role === 'level2' && identity.organizationId !== record.organizationId)
    ) {
      await this.recordAdminEvent(identity, {
        organizationId: identity.organizationId,
        action: 'audit.conversation.view',
        targetType: 'conversation_audit',
        targetId: auditId,
        outcome: 'denied',
        errorCode: 'forbidden'
      })
      throw forbidden()
    }
    await this.recordAdminEvent(identity, {
      organizationId: record.organizationId,
      action: 'audit.conversation.view',
      targetType: 'conversation_audit',
      targetId: auditId,
      outcome: 'allowed'
    })
    return record
  }

  async adminEvents(identity: AccessIdentity, query: {
    organizationId?: string
    limit?: number
  }) {
    this.requireAdministrator(identity)
    const organizationId = identity.role === 'level2'
      ? identity.organizationId || undefined
      : query.organizationId
    return {
      events: await this.repository.listAdminEvents({
        ...(organizationId ? { organizationId } : {}),
        ...(query.limit ? { limit: query.limit } : {})
      })
    }
  }

  async setRetention(
    identity: AccessIdentity,
    organizationId: string,
    daysValue: unknown
  ): Promise<{ organizationId: string; days: number }> {
    if (identity.role !== 'level1') {
      await this.recordAdminEvent(identity, {
        organizationId: identity.organizationId,
        action: 'audit.retention.update',
        targetType: 'organization',
        targetId: organizationId,
        outcome: 'denied',
        errorCode: 'forbidden'
      })
      throw forbidden()
    }
    const days = Number(daysValue)
    if (!Number.isInteger(days) || days < 7 || days > 180) {
      throw new SafeError({
        code: 'invalid_audit_retention',
        message: '审计正文保留期必须为 7–180 天。',
        statusCode: 400
      })
    }
    const now = this.clock.now().toISOString()
    await this.repository.inTransaction(async repository => {
      if (!await repository.setOrganizationRetentionDays(organizationId, days, now)) {
        throw new SafeError({
          code: 'not_found',
          message: '组织不存在。',
          statusCode: 404
        })
      }
      for (const body of await repository.listRetainedBodies(organizationId)) {
        await repository.setBodyExpiry(
          body.id,
          new Date(Date.parse(body.createdAt) + days * DAY_MS).toISOString()
        )
      }
      await this.insertAdminEvent(repository, identity, {
        organizationId,
        action: 'audit.retention.update',
        targetType: 'organization',
        targetId: organizationId,
        outcome: 'allowed',
        metadata: { days }
      })
    })
    return { organizationId, days }
  }

  async recordAdminEvent(
    identity: AccessIdentity,
    input: {
      organizationId: string | null
      action: string
      targetType: string
      targetId: string | null
      outcome: 'allowed' | 'denied' | 'failed'
      errorCode?: string | null
      metadata?: Record<string, unknown>
    }
  ): Promise<void> {
    await this.insertAdminEvent(this.repository, identity, input)
  }

  private async insertAdminEvent(
    repository: AuditRepository,
    identity: AccessIdentity,
    input: {
      organizationId: string | null
      action: string
      targetType: string
      targetId: string | null
      outcome: 'allowed' | 'denied' | 'failed'
      errorCode?: string | null
      metadata?: Record<string, unknown>
    }
  ): Promise<void> {
    const event: AdminAuditEventRecord = {
      id: this.ids.opaque('audit'),
      actorAccountId: identity.accountId,
      actorRole: identity.role,
      organizationId: input.organizationId,
      action: input.action.slice(0, 160),
      targetType: input.targetType.slice(0, 120),
      targetId: input.targetId?.slice(0, 240) || null,
      outcome: input.outcome,
      errorCode: input.errorCode?.slice(0, 120) || null,
      metadata: safeMetadata(input.metadata),
      createdAt: this.clock.now().toISOString()
    }
    await repository.insertAdminEvent(event)
  }

  private requireAdministrator(identity: AccessIdentity): void {
    if (identity.role === 'user') throw forbidden()
    if (identity.role === 'level2' && !identity.organizationId) throw forbidden()
  }
}
