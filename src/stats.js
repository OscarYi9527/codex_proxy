// Usage statistics accumulator
import fs from 'fs'
import path from 'path'
import { PROXY_DIR } from './config.js'

const STATS_FILE = path.join(PROXY_DIR, '..', 'codex-proxy-stats.json')
let stats = { updated: new Date().toISOString(), providers: {} }

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stats = parsed
      stats.updated = stats.updated || new Date().toISOString()
      return
    }
  } catch {}
  stats = { updated: new Date().toISOString(), providers: {} }
}
loadStats()

export function saveStats() {
  stats.updated = new Date().toISOString()
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)) } catch {}
}

function ensureProvider(p) {
  if (!stats.providers[p]) stats.providers[p] = { requests: 0, input_tokens: 0, output_tokens: 0, models: {} }
  return stats.providers[p]
}

function ensureModel(p, m) {
  const pr = ensureProvider(p)
  if (!pr.models[m]) pr.models[m] = { requests: 0, input_tokens: 0, output_tokens: 0 }
  return pr.models[m]
}

export function recordUsage(model, provider, inputTokens, outputTokens) {
  if (!model || !provider) return
  const i = Math.max(0, Number(inputTokens) || 0)
  const o = Math.max(0, Number(outputTokens) || 0)
  const pr = ensureProvider(provider)
  const md = ensureModel(provider, model)
  pr.requests++
  pr.input_tokens += i
  pr.output_tokens += o
  md.requests++
  md.input_tokens += i
  md.output_tokens += o
}

export function getStats() { return structuredClone(stats) }

export function resetStats() {
  stats = { updated: new Date().toISOString(), providers: {} }
  saveStats()
  return stats
}

// Auto-save every 30 seconds
// Auto-save every 30 seconds (skip in test mode)
if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  setInterval(saveStats, 30000)
}
