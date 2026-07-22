import { proxyConfig } from './config.js'
import { accountRemainingPercent } from './chatgpt-accounts.js'
import { getProviderHealth } from './provider-health.js'
import { requestLog, safeErrorText } from './logger.js'
import { budgetDecision, BudgetExceededError, targetUnitCost } from './cost-governance.js'

export const DEFERRED_ERROR_BODY_LIMIT_BYTES = 64 * 1024
const DEFERRED_BODY_TOO_LARGE = 'UPSTREAM_ERROR_BODY_TOO_LARGE'

export const VIRTUAL_MODELS = [
  { id: 'auto', name: 'Auto · 综合质量与可用性', profile: 'balanced' },
  { id: 'auto-fast', name: 'Auto Fast · 优先低延迟', profile: 'fast' },
  { id: 'auto-cheap', name: 'Auto Cheap · 优先低成本', profile: 'cheap' },
  { id: 'auto-reliable', name: 'Auto Reliable · 优先成功率与额度', profile: 'reliable' }
]

export function isVirtualModel(model) {
  return VIRTUAL_MODELS.some(item => item.id === model)
}

export function providerForModel(model) {
  if (typeof model !== 'string') return 'deepseek'
  if (model.startsWith('relay-')) {
    const parts = model.split('-')
    return parts.length >= 3 ? `relay:${parts[1]}` : 'relay'
  }
  if (model.startsWith('openai-api-')) return 'openai-api'
  if (/^gpt-/i.test(model)) return 'chatgpt-sub'
  return 'deepseek'
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') return null
  const provider = String(target.provider || '').trim()
  const model = String(target.model || '').trim()
  if (!provider || !model) return null
  return { provider, model }
}

function configuredTargets() {
  return (proxyConfig.fallbackChain || []).map(normalizeTarget).filter(Boolean)
}

function virtualTargets() {
  const targets = configuredTargets()
  for (const relay of proxyConfig.relays || []) {
    const upstreamModel = relay.models?.[0]
    if (relay.api_key && upstreamModel) {
      targets.push({ provider: `relay:${relay.id}`, model: `relay-${relay.id}-${upstreamModel}` })
    }
  }
  return targets
}

function providerAvailable(target, req) {
  if (target.provider === 'chatgpt-sub') {
    return (proxyConfig.chatgptAccounts || []).some(account =>
      account.routing_enabled !== false && Boolean(account.access_token || account.refresh_token)
    ) || Boolean(req?.headers?.authorization && req?.headers?.['chatgpt-account-id'])
  }
  if (target.provider === 'openai-api') {
    if (proxyConfig.openaiApiKey) return true
    if (String(proxyConfig.openaiApiUpstream || '').startsWith('relay:')) {
      const id = proxyConfig.openaiApiUpstream.slice('relay:'.length)
      return Boolean((proxyConfig.relays || []).find(relay => relay.id === id)?.api_key)
    }
    return false
  }
  if (target.provider === 'deepseek') return Boolean(proxyConfig.deepseekApiKey)
  if (target.provider.startsWith('relay:')) {
    const id = target.provider.slice('relay:'.length)
    return Boolean((proxyConfig.relays || []).find(relay => relay.id === id)?.api_key)
  }
  return false
}

function effectiveProvider(target) {
  if (target.provider === 'openai-api' && String(proxyConfig.openaiApiUpstream || '').startsWith('relay:')) {
    return proxyConfig.openaiApiUpstream
  }
  return target.provider
}

function targetMetrics(target, health) {
  const provider = health.providers?.[target.provider] || {}
  const day = provider.windows?.['24h'] || {}
  const remaining = target.provider === 'chatgpt-sub'
    ? Math.max(0, ...(proxyConfig.chatgptAccounts || [])
        .filter(account => account.routing_enabled !== false)
        .map(account => accountRemainingPercent(account) ?? 50))
    : 50
  const stateScore = provider.state === 'healthy' ? 100
    : provider.state === 'degraded' ? 55
      : provider.state === 'unknown' || !provider.state ? 65
        : 10
  return {
    latency: Number(day.p95_latency_ms || provider.last_latency_ms || 5000),
    success: day.success_rate == null ? stateScore : Number(day.success_rate),
    remaining,
    stateScore,
    free: target.provider === 'chatgpt-sub'
  }
}

function sortVirtualTargets(targets, profile) {
  const health = getProviderHealth()
  return [...targets].sort((left, right) => {
    const a = targetMetrics(left, health)
    const b = targetMetrics(right, health)
    if (profile === 'fast') return a.latency - b.latency || b.success - a.success
    if (profile === 'cheap') {
      return targetUnitCost(effectiveProvider(left), left.model) - targetUnitCost(effectiveProvider(right), right.model) ||
        b.success - a.success || a.latency - b.latency
    }
    if (profile === 'reliable') {
      const aScore = a.success * 0.65 + a.remaining * 0.25 + a.stateScore * 0.1
      const bScore = b.success * 0.65 + b.remaining * 0.25 + b.stateScore * 0.1
      return bScore - aScore || a.latency - b.latency
    }
    const aScore = a.success * 0.5 + a.remaining * 0.2 + a.stateScore * 0.2 + Math.max(0, 100 - a.latency / 50) * 0.1
    const bScore = b.success * 0.5 + b.remaining * 0.2 + b.stateScore * 0.2 + Math.max(0, 100 - b.latency / 50) * 0.1
    return bScore - aScore
  })
}

export function buildRoutingPlan(req, resolved) {
  const requestedModel = resolved.model
  const targets = configuredTargets()
  if (isVirtualModel(requestedModel)) {
    const profile = VIRTUAL_MODELS.find(item => item.id === requestedModel)?.profile || 'balanced'
    const available = virtualTargets().filter(target => providerAvailable(target, req))
    const unique = []
    const seen = new Set()
    for (const target of sortVirtualTargets(available, profile)) {
      if (seen.has(target.provider)) continue
      seen.add(target.provider)
      unique.push({ ...target, virtualModel: requestedModel })
    }
    return unique
  }

  const initial = { provider: providerForModel(requestedModel), model: requestedModel }
  if (!proxyConfig.crossProviderFallbackEnabled) return [initial]
  const matchingIndex = targets.findIndex(target => target.provider === initial.provider)
  const fallbackTargets = matchingIndex >= 0 ? targets.slice(matchingIndex + 1) : targets
  const plan = [initial]
  const seen = new Set([initial.provider])
  for (const target of fallbackTargets) {
    if (seen.has(target.provider) || !providerAvailable(target, req)) continue
    seen.add(target.provider)
    plan.push(target)
  }
  return plan
}

export function shouldFallbackResponse(status, errorType = '') {
  const code = Number(status) || 0
  if ([400, 401, 402, 403, 404, 409, 422].includes(code)) return false
  if (/authentication|permission|billing|invalid_request/i.test(errorType)) return false
  return (proxyConfig.fallbackStatuses || [429, 502, 503, 504]).map(Number).includes(code)
}

export class DeferredErrorResponse {
  constructor(realResponse, initialMeta = {}) {
    this.real = realResponse
    this.proxyMeta = { ...initialMeta }
    this.statusCode = 200
    this.headers = new Map()
    this.bodyBuffer = null
    this.bufferedBytes = 0
    this.bodyTruncated = false
    this.passthrough = false
    this.bufferedEnded = false
  }

  get headersSent() { return this.passthrough ? this.real.headersSent : this._headersSent === true }
  get writableEnded() { return this.passthrough ? this.real.writableEnded : this.bufferedEnded }
  get destroyed() { return this.real.destroyed }
  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); return this }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()) }
  removeHeader(name) { this.headers.delete(String(name).toLowerCase()) }
  once(...args) { this.real.once(...args); return this }
  on(...args) { this.real.on(...args); return this }
  off(...args) { this.real.off?.(...args); return this }
  removeListener(...args) { this.real.removeListener?.(...args); return this }
  get chunks() {
    return this.bodyBuffer && this.bufferedBytes
      ? [this.bodyBuffer.subarray(0, this.bufferedBytes)]
      : []
  }

  writeHead(status, headers = {}) {
    this.statusCode = Number(status) || 500
    for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value)
    this._headersSent = true
    if (this.statusCode < 400) {
      this.passthrough = true
      this.real.writeHead(this.statusCode, Object.fromEntries(this.headers))
    }
    return this
  }

  write(chunk) {
    if (this.passthrough) return this.real.write(chunk)
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (buffer.length === 0) return true
    this.bodyBuffer ||= Buffer.allocUnsafe(DEFERRED_ERROR_BODY_LIMIT_BYTES)
    const remaining = DEFERRED_ERROR_BODY_LIMIT_BYTES - this.bufferedBytes
    if (remaining <= 0) {
      this.bodyTruncated = true
      throw this.bodyTooLargeError()
    }
    const keptLength = Math.min(buffer.length, remaining)
    buffer.copy(this.bodyBuffer, this.bufferedBytes, 0, keptLength)
    this.bufferedBytes += keptLength
    if (keptLength < buffer.length) {
      this.bodyTruncated = true
      throw this.bodyTooLargeError()
    }
    return true
  }

  bodyTooLargeError() {
    return Object.assign(new Error(
      `Upstream error response exceeded ${DEFERRED_ERROR_BODY_LIMIT_BYTES} bytes`
    ), {
      code: DEFERRED_BODY_TOO_LARGE,
      status: this.statusCode,
      statusCode: this.statusCode
    })
  }

  end(chunk) {
    if (chunk != null) this.write(chunk)
    if (this.passthrough) return this.real.end()
    this.bufferedEnded = true
    return this
  }

  errorType() {
    const text = Buffer.concat(this.chunks, this.bufferedBytes).toString('utf8')
    try {
      const payload = JSON.parse(text)
      return String(payload?.error?.type || '')
    } catch {
      const errorStart = text.search(/"error"\s*:/)
      const match = errorStart >= 0
        ? text.slice(errorStart).match(/"type"\s*:\s*"((?:\\.|[^"\\])*)"/)
        : null
      if (!match) return ''
      try {
        return String(JSON.parse(`"${match[1]}"`))
      } catch {
        return match[1]
      }
    }
  }

  replay() {
    if (this.real.headersSent || this.real.writableEnded) return
    let replayChunks = this.chunks
    if (this.bodyTruncated) {
      const payload = Buffer.from(JSON.stringify({
        error: {
          type: this.errorType() || 'upstream_error_body_too_large',
          message: `Upstream error response exceeded ${DEFERRED_ERROR_BODY_LIMIT_BYTES} bytes and was truncated.`
        }
      }))
      replayChunks = [payload]
      this.headers.set('content-type', 'application/json; charset=utf-8')
      this.headers.set('content-length', String(payload.length))
      this.headers.delete('content-encoding')
      this.headers.delete('transfer-encoding')
    }
    this.real.writeHead(this.statusCode, Object.fromEntries(this.headers))
    for (const chunk of replayChunks) this.real.write(chunk)
    this.real.end()
  }
}

function statusForThrownError(error) {
  if (error?.code === 'TOKEN_REFRESH_PERMANENT') return 401
  if (error?.code === 'CIRCUIT_OPEN') return 503
  return 502
}

export async function executeRoutingPlan(req, res, body, resolved, dispatch) {
  const plan = buildRoutingPlan(req, resolved)
  if (!plan.length) {
    const error = new Error(`No configured provider is available for virtual model "${resolved.model}"`)
    error.status = 503
    error.code = 'NO_VIRTUAL_ROUTE'
    throw error
  }
  let lastBuffered = null
  let lastError = null
  for (let index = 0; index < plan.length; index++) {
    const target = plan[index]
    const budget = budgetDecision(effectiveProvider(target))
    if (budget.exceeded) {
      if (budget.action === 'fallback' && index < plan.length - 1) {
        requestLog(req, `budget_fallback from=${target.provider} reason=${budget.reason} to=${plan[index + 1].provider}`)
        continue
      }
      throw new BudgetExceededError(budget)
    }
    const attemptResolved = {
      ...resolved,
      model: target.model,
      bodyModel: resolved.bodyModel,
      virtualModel: target.virtualModel || null
    }
    const attemptBody = { ...body, model: target.model }
    const attemptRes = new DeferredErrorResponse(res, {
      ...(res.proxyMeta || {}),
      model: target.model,
      fallbackAttempts: index
    })
    try {
      await dispatch(target, attemptRes, attemptBody, attemptResolved)
      if (attemptRes.passthrough || res.headersSent || res.writableEnded) return { target, attempts: index + 1 }
      lastBuffered = attemptRes
      const errorType = attemptRes.errorType()
      if (index < plan.length - 1 && shouldFallbackResponse(attemptRes.statusCode, errorType)) {
        requestLog(req, `cross_provider_fallback from=${target.provider} status=${attemptRes.statusCode} to=${plan[index + 1].provider}`)
        continue
      }
      attemptRes.replay()
      return { target, attempts: index + 1, status: attemptRes.statusCode }
    } catch (error) {
      lastError = error
      if (attemptRes.passthrough || res.headersSent) throw error
      if (error?.code === DEFERRED_BODY_TOO_LARGE) {
        lastBuffered = attemptRes
        const errorType = attemptRes.errorType()
        if (index < plan.length - 1 && shouldFallbackResponse(attemptRes.statusCode, errorType)) {
          requestLog(req, `cross_provider_fallback from=${target.provider} status=${attemptRes.statusCode} reason=error_body_too_large to=${plan[index + 1].provider}`)
          continue
        }
        attemptRes.replay()
        return { target, attempts: index + 1, status: attemptRes.statusCode }
      }
      const status = statusForThrownError(error)
      if (index < plan.length - 1 && shouldFallbackResponse(status, error.code || '')) {
        requestLog(req, `cross_provider_fallback from=${target.provider} error=${safeErrorText(error.code || error)} to=${plan[index + 1].provider}`)
        continue
      }
      throw error
    }
  }
  if (lastBuffered) {
    lastBuffered.replay()
    return { attempts: plan.length, status: lastBuffered.statusCode }
  }
  throw lastError || new Error('Routing plan exhausted')
}
