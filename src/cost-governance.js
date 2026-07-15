import { proxyConfig } from './config.js'
import { getStats, statsDayKey } from './stats.js'
import { getPriceCatalog, priceForModel } from './pricing.js'

function normalizedBudget(provider) {
  const budgets = proxyConfig.providerBudgets || {}
  const value = budgets[provider] || (provider.startsWith('relay:') ? budgets['relay:*'] : null)
  if (!value || typeof value !== 'object') return null
  return {
    daily_usd: Math.max(0, Number(value.daily_usd) || 0),
    monthly_usd: Math.max(0, Number(value.monthly_usd) || 0),
    action: value.action === 'stop' ? 'stop' : 'fallback'
  }
}

export function providerSpend(provider, stats = getStats(), now = Date.now()) {
  const dayKey = statsDayKey(now)
  const monthKey = dayKey.slice(0, 7)
  const daily = Number(stats.daily?.[dayKey]?.providers?.[provider]?.estimated_cost_usd || 0)
  let monthly = 0
  for (const [day, value] of Object.entries(stats.daily || {})) {
    if (day.startsWith(monthKey)) {
      monthly += Number(value.providers?.[provider]?.estimated_cost_usd || 0)
    }
  }
  return {
    daily_usd: Number(daily.toFixed(8)),
    monthly_usd: Number(monthly.toFixed(8))
  }
}

export function budgetDecision(provider, stats = getStats()) {
  const budget = normalizedBudget(provider)
  const spend = providerSpend(provider, stats)
  if (!budget) return { provider, configured: false, exceeded: false, action: 'fallback', budget: null, spend }
  const dailyExceeded = budget.daily_usd > 0 && spend.daily_usd >= budget.daily_usd
  const monthlyExceeded = budget.monthly_usd > 0 && spend.monthly_usd >= budget.monthly_usd
  return {
    provider,
    configured: true,
    exceeded: dailyExceeded || monthlyExceeded,
    reason: dailyExceeded ? 'daily_budget_exceeded' : (monthlyExceeded ? 'monthly_budget_exceeded' : null),
    action: budget.action,
    budget,
    spend
  }
}

export function getCostReport() {
  const stats = getStats()
  const catalog = getPriceCatalog()
  const providers = {}
  const providerIds = new Set([
    ...Object.keys(stats.providers || {}),
    ...Object.keys(proxyConfig.providerBudgets || {}),
    'chatgpt-sub',
    'openai-api',
    'deepseek'
  ])
  for (const provider of providerIds) {
    providers[provider] = {
      ...providerSpend(provider, stats),
      total_usd: Number(stats.providers?.[provider]?.estimated_cost_usd || 0),
      budget: budgetDecision(provider, stats)
    }
  }
  return {
    generated_at: new Date().toISOString(),
    currency: catalog.currency || 'USD',
    catalog_updated_at: catalog.updated_at || null,
    total_usd: Number(Object.values(stats.providers || {}).reduce(
      (sum, value) => sum + Number(value.estimated_cost_usd || 0), 0
    ).toFixed(8)),
    today_usd: Number(Object.values(stats.daily?.[statsDayKey()]?.providers || {}).reduce(
      (sum, value) => sum + Number(value.estimated_cost_usd || 0), 0
    ).toFixed(8)),
    providers
  }
}

export function targetUnitCost(provider, model) {
  const price = priceForModel(provider, model)
  if (!price) return Number.POSITIVE_INFINITY
  return Number(price.input_per_million || 0) + Number(price.output_per_million || 0)
}

export class BudgetExceededError extends Error {
  constructor(decision) {
    super(`${decision.provider} ${decision.reason === 'daily_budget_exceeded' ? 'daily' : 'monthly'} budget is exhausted`)
    this.name = 'BudgetExceededError'
    this.code = 'BUDGET_EXCEEDED'
    this.status = 402
    this.decision = decision
  }
}
