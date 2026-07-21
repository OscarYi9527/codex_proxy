import { proxyConfig } from './config.js'
import { accountRemainingPercent } from './chatgpt-accounts.js'
import { getProviderHealth } from './provider-health.js'
import { requestLog, safeErrorText } from './logger.js'
import { budgetDecision, BudgetExceededError, targetUnitCost } from './cost-governance.js'

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
    this.chunks = []
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
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }

  end(chunk) {
    if (chunk != null) this.write(chunk)
    if (this.passthrough) return this.real.end()
    this.bufferedEnded = true
    return this
  }

  errorType() {
    try {
      const payload = JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
      return String(payload?.error?.type || '')
    } catch {
      return ''
    }
  }

  replay() {
    if (this.real.headersSent || this.real.writableEnded) return
    this.real.writeHead(this.statusCode, Object.fromEntries(this.headers))
    for (const chunk of this.chunks) this.real.write(chunk)
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
