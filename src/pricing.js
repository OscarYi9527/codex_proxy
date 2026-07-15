import fs from 'fs'
import path from 'path'
import { PROXY_DIR, atomicWriteJson } from './config.js'

const PRICE_FILE = path.join(PROXY_DIR, '..', 'model-prices.json')

function defaultCatalog() {
  return {
    schema_version: 1,
    currency: 'USD',
    updated_at: null,
    notice: 'No local model price catalog is available.',
    prices: {}
  }
}

export function getPriceCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.prices && typeof parsed.prices === 'object') {
      return parsed
    }
  } catch {}
  return defaultCatalog()
}

function validateRate(value, field) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) {
    throw new Error(`${field} must be a non-negative finite number`)
  }
  return number
}

export function normalizePriceCatalog(input, updatedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input.prices)) {
    throw new Error('prices must be an object')
  }
  const prices = {}
  for (const [key, value] of Object.entries(input.prices || {})) {
    const normalizedKey = String(key).trim()
    if (!normalizedKey || !value || typeof value !== 'object') continue
    prices[normalizedKey] = {
      input_per_million: validateRate(value.input_per_million, `${normalizedKey}.input_per_million`),
      output_per_million: validateRate(value.output_per_million, `${normalizedKey}.output_per_million`),
      kind: String(value.kind || 'custom').slice(0, 40)
    }
  }
  const catalog = {
    schema_version: 1,
    currency: 'USD',
    updated_at: updatedAt,
    notice: String(input.notice || 'Local editable cost estimates.').slice(0, 500),
    prices
  }
  return catalog
}

export function updatePriceCatalog(input) {
  const catalog = normalizePriceCatalog(input)
  atomicWriteJson(PRICE_FILE, catalog)
  return catalog
}

export function priceForModel(provider, model, catalog = getPriceCatalog()) {
  const exact = catalog.prices?.[`${provider}:${model}`]
  if (exact) return exact
  if (provider?.startsWith('relay:')) {
    const relayExact = catalog.prices?.[`relay:${provider.slice('relay:'.length)}:${model}`]
    if (relayExact) return relayExact
    if (catalog.prices?.['relay:*']) return catalog.prices['relay:*']
  }
  return catalog.prices?.[`${provider}:*`] || null
}

export function estimateRequestCost(provider, model, inputTokens = 0, outputTokens = 0, catalog = getPriceCatalog()) {
  const price = priceForModel(provider, model, catalog)
  if (!price) return { estimated_cost_usd: null, price: null }
  const input = Math.max(0, Number(inputTokens) || 0)
  const output = Math.max(0, Number(outputTokens) || 0)
  const estimated = (
    input * Number(price.input_per_million || 0) +
    output * Number(price.output_per_million || 0)
  ) / 1_000_000
  return {
    estimated_cost_usd: Number(estimated.toFixed(8)),
    price
  }
}
