import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  createProviderUsageReceipt,
  sha256Hex
} from './protocol.js'

const SCHEMA_VERSION = 1
const DEFAULT_ACKNOWLEDGED_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_ACKNOWLEDGEMENTS = 100
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,160}$/

function validUsage(value) {
  return value &&
    Number.isSafeInteger(value.inputTokens) &&
    value.inputTokens >= 0 &&
    Number.isSafeInteger(value.outputTokens) &&
    value.outputTokens >= 0
}

function opaqueId(prefix, value) {
  return `${prefix}_${sha256Hex(Buffer.from(value, 'utf8')).slice(0, 32)}`
}

function safeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (
    !OPAQUE_ID.test(String(value.turnId || '')) ||
    !OPAQUE_ID.test(String(value.executionId || '')) ||
    !OPAQUE_ID.test(String(value.outboxId || '')) ||
    !/^[a-f0-9]{64}$/.test(String(value.fingerprint || '')) ||
    !['running', 'completed', 'failed', 'cancelled', 'recovery_required']
      .includes(value.state) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.updatedAt)
  ) {
    return null
  }
  if (value.state === 'completed' && (
    !OPAQUE_ID.test(String(value.providerId || '')) ||
    !validUsage(value.usage) ||
    !Number.isSafeInteger(value.completedAt)
  )) {
    return null
  }
  if (value.acknowledgement !== null && value.acknowledgement !== undefined) {
    const acknowledgement = value.acknowledgement
    if (
      !acknowledgement ||
      typeof acknowledgement !== 'object' ||
      !OPAQUE_ID.test(String(acknowledgement.gatewayId || '')) ||
      !OPAQUE_ID.test(String(acknowledgement.settlementId || '')) ||
      typeof acknowledgement.settledAt !== 'string' ||
      !Number.isFinite(Date.parse(acknowledgement.settledAt)) ||
      !Number.isSafeInteger(acknowledgement.acknowledgedAt)
    ) {
      return null
    }
  }
  return {
    turnId: String(value.turnId),
    executionId: String(value.executionId),
    outboxId: String(value.outboxId),
    fingerprint: String(value.fingerprint),
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    providerId: value.providerId ? String(value.providerId) : null,
    usage: value.usage
      ? {
          inputTokens: value.usage.inputTokens,
          outputTokens: value.usage.outputTokens
        }
      : null,
    completedAt: Number.isSafeInteger(value.completedAt)
      ? value.completedAt
      : null,
    errorCode: value.errorCode ? String(value.errorCode).slice(0, 120) : null,
    acknowledgement: value.acknowledgement
      ? {
          gatewayId: String(value.acknowledgement.gatewayId),
          settlementId: String(value.acknowledgement.settlementId),
          settledAt: String(value.acknowledgement.settledAt),
          acknowledgedAt: value.acknowledgement.acknowledgedAt
        }
      : null
  }
}

export class ExecutionStore {
  constructor(options) {
    this.now = options.now || (() => Date.now())
    this.signingSecret = options.signingSecret
    this.workerId = options.workerId
    this.region = options.region
    this.file = path.join(options.dataRoot, 'provider-worker-executions-v1.json')
    this.acknowledgedRetentionMs =
      options.acknowledgedRetentionMs || DEFAULT_ACKNOWLEDGED_RETENTION_MS
    this.executions = new Map()
    this.#load()
    this.#recoverInterrupted()
    this.cleanup()
  }

  begin(turnId, fingerprint) {
    this.cleanup()
    const existing = this.executions.get(turnId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { state: 'conflict', execution: existing }
      }
      return { state: existing.state, execution: existing }
    }
    const now = this.now()
    const execution = {
      turnId,
      executionId: opaqueId(
        'exec',
        `${this.workerId}\0${turnId}\0${fingerprint}`
      ),
      outboxId: opaqueId(
        'outbox',
        `${this.workerId}\0${turnId}\0usage-v1`
      ),
      fingerprint,
      state: 'running',
      createdAt: now,
      updatedAt: now,
      providerId: null,
      usage: null,
      completedAt: null,
      errorCode: null,
      acknowledgement: null
    }
    this.executions.set(turnId, execution)
    this.#persist()
    return { state: 'started', execution }
  }

  complete(turnId, result) {
    const execution = this.executions.get(turnId)
    if (!execution || execution.state !== 'running') return false
    if (!OPAQUE_ID.test(String(result.providerId || '')) || !validUsage(result.usage)) {
      throw Object.assign(new Error('Provider Worker completion usage is invalid'), {
        code: 'worker_usage_invalid',
        statusCode: 502
      })
    }
    const now = this.now()
    execution.state = 'completed'
    execution.providerId = String(result.providerId)
    execution.usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens
    }
    execution.completedAt = now
    execution.updatedAt = now
    execution.errorCode = null
    this.#persist()
    return true
  }

  fail(turnId, code) {
    const execution = this.executions.get(turnId)
    if (!execution || execution.state !== 'running') return
    execution.state = 'failed'
    execution.errorCode = String(code || 'worker_provider_failed').slice(0, 120)
    execution.updatedAt = this.now()
    this.#persist()
  }

  cancel(turnId) {
    const execution = this.executions.get(turnId)
    if (!execution || execution.state !== 'running') return execution || null
    execution.state = 'cancelled'
    execution.errorCode = 'worker_turn_cancelled'
    execution.updatedAt = this.now()
    this.#persist()
    return execution
  }

  get(turnId) {
    return this.executions.get(turnId) || null
  }

  receipt(execution) {
    if (!execution || execution.state !== 'completed') return null
    return createProviderUsageReceipt({
      outboxId: execution.outboxId,
      executionId: execution.executionId,
      turnId: execution.turnId,
      workerId: this.workerId,
      region: this.region,
      providerId: execution.providerId,
      inputTokens: execution.usage.inputTokens,
      outputTokens: execution.usage.outputTokens,
      completedAt: new Date(execution.completedAt).toISOString()
    }, this.signingSecret)
  }

  pending(limit = 100) {
    this.cleanup()
    const bounded = Math.min(Math.max(Number(limit) || 1, 1), 100)
    return [...this.executions.values()]
      .filter(execution =>
        execution.state === 'completed' &&
        execution.acknowledgement === null
      )
      .sort((left, right) =>
        left.completedAt - right.completedAt ||
        left.outboxId.localeCompare(right.outboxId)
      )
      .slice(0, bounded)
      .map(execution => this.receipt(execution))
  }

  acknowledge(gatewayId, acknowledgements) {
    if (
      !Array.isArray(acknowledgements) ||
      acknowledgements.length < 1 ||
      acknowledgements.length > MAX_ACKNOWLEDGEMENTS
    ) {
      throw Object.assign(new Error('Provider Worker acknowledgements are invalid'), {
        code: 'worker_settlement_ack_invalid',
        statusCode: 400
      })
    }
    const acknowledged = []
    const alreadyAcknowledged = []
    const now = this.now()
    const resolved = []
    const seen = new Set()
    for (const value of acknowledgements) {
      if (
        !value ||
        typeof value !== 'object' ||
        !OPAQUE_ID.test(String(value.outboxId || '')) ||
        !OPAQUE_ID.test(String(value.turnId || '')) ||
        !OPAQUE_ID.test(String(value.settlementId || '')) ||
        typeof value.settledAt !== 'string' ||
        !Number.isFinite(Date.parse(value.settledAt))
      ) {
        throw Object.assign(new Error('Provider Worker acknowledgement is malformed'), {
          code: 'worker_settlement_ack_invalid',
          statusCode: 400
        })
      }
      if (seen.has(value.outboxId)) {
        throw Object.assign(new Error('Provider Worker acknowledgement is duplicated'), {
          code: 'worker_settlement_ack_invalid',
          statusCode: 400
        })
      }
      seen.add(value.outboxId)
      const execution = this.executions.get(value.turnId)
      if (
        !execution ||
        execution.state !== 'completed' ||
        execution.outboxId !== value.outboxId
      ) {
        throw Object.assign(new Error('Provider Worker outbox record was not found'), {
          code: 'worker_outbox_not_found',
          statusCode: 404
        })
      }
      if (execution.acknowledgement) {
        if (
          execution.acknowledgement.gatewayId !== gatewayId ||
          execution.acknowledgement.settlementId !== value.settlementId
        ) {
          throw Object.assign(new Error('Provider Worker settlement acknowledgement conflicts'), {
            code: 'worker_settlement_ack_conflict',
            statusCode: 409
          })
        }
        alreadyAcknowledged.push(execution.outboxId)
        continue
      }
      resolved.push({ execution, value })
    }
    for (const { execution, value } of resolved) {
      execution.acknowledgement = {
        gatewayId,
        settlementId: value.settlementId,
        settledAt: value.settledAt,
        acknowledgedAt: now
      }
      execution.updatedAt = now
      acknowledged.push(execution.outboxId)
    }
    if (acknowledged.length) this.#persist()
    return { acknowledged, alreadyAcknowledged }
  }

  cleanup() {
    const cutoff = this.now() - this.acknowledgedRetentionMs
    let changed = false
    for (const [turnId, execution] of this.executions) {
      if (
        (
          execution.acknowledgement &&
          execution.acknowledgement.acknowledgedAt <= cutoff
        ) ||
        (
          ['failed', 'cancelled', 'recovery_required'].includes(execution.state) &&
          execution.updatedAt <= cutoff
        )
      ) {
        this.executions.delete(turnId)
        changed = true
      }
    }
    if (changed) this.#persist()
  }

  #load() {
    if (!fs.existsSync(this.file)) return
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (error) {
      throw new Error(`Provider Worker execution state is unreadable: ${error.message}`)
    }
    if (
      parsed?.schemaVersion !== SCHEMA_VERSION ||
      parsed.workerId !== this.workerId ||
      parsed.region !== this.region ||
      !Array.isArray(parsed.executions)
    ) {
      throw new Error('Provider Worker execution state metadata is invalid')
    }
    for (const candidate of parsed.executions) {
      const execution = safeRecord(candidate)
      if (!execution || this.executions.has(execution.turnId)) {
        throw new Error('Provider Worker execution state contains an invalid record')
      }
      this.executions.set(execution.turnId, execution)
    }
  }

  #recoverInterrupted() {
    let changed = false
    for (const execution of this.executions.values()) {
      if (execution.state !== 'running') continue
      execution.state = 'recovery_required'
      execution.errorCode = 'worker_restarted_before_completion'
      execution.updatedAt = this.now()
      changed = true
    }
    if (changed) this.#persist()
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    const payload = `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      workerId: this.workerId,
      region: this.region,
      executions: [...this.executions.values()]
    }, null, 2)}\n`
    try {
      fs.writeFileSync(temporary, payload, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      fs.renameSync(temporary, this.file)
      try {
        fs.chmodSync(this.file, 0o600)
      } catch {
        // Windows ACLs are inherited from the isolated data root.
      }
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
    }
  }
}
