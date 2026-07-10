// Model resolution and catalog helpers
import fs from 'fs'
import path from 'path'
import { proxyConfig, PROXY_DIR, getRelay } from './config.js'

const THREAD_ROUTES_DIR = process.env.CODEX_PROXY_THREAD_ROUTES_DIR || path.join(PROXY_DIR, '..', 'codex-thread-routes')
try { fs.mkdirSync(THREAD_ROUTES_DIR, { recursive: true }) } catch {}

// ── Four upstream channels ──────────────────────────────────────
//   gpt-*          → ChatGPT 订阅 (Codex Auth)
//   openai-api-*   → OpenAI API (用户 API Key)
//   relay-*        → GPT 中转站 (用户自定义兼容端点)
//   其他            → DeepSeek (Anthropic API)

export function isChatGptSubModel(model) {
  return typeof model === 'string' && /^gpt-(?!.*-api)/i.test(model) && !model.startsWith('openai-api-') && !model.startsWith('relay-')
}

export function isOpenAIApiModel(model) {
  return typeof model === 'string' && model.startsWith('openai-api-')
}

export function isRelayModel(model) {
  return typeof model === 'string' && model.startsWith('relay-')
}

// Parse relay model slug: relay-{relayId}-{upstreamModel}
export function parseRelayModel(model) {
  if (!isRelayModel(model)) return null
  const parts = model.split('-')
  // relay-{id}-{model...}
  if (parts.length < 3) return null
  const relayId = parts[1]
  const upstreamModel = parts.slice(2).join('-')
  const relay = getRelay(relayId)
  return relay ? { relayId, upstreamModel, relay } : null
}

// Map catalog slug → upstream API model name for OpenAI API channel
const OPENAI_API_MODEL_MAP = new Map([
  ['openai-api-gpt-5.6-sol', 'gpt-5.6-sol'],
  ['openai-api-gpt-5.6-sol-compact', 'gpt-5.6-sol'],
  ['openai-api-gpt-5.6-terra', 'gpt-5.6-terra'],
  ['openai-api-gpt-5.6-terra-compact', 'gpt-5.6-terra'],
  ['openai-api-gpt-5.6-luna', 'gpt-5.6-luna'],
  ['openai-api-gpt-5.5', 'gpt-5.5'],
  ['openai-api-gpt-5.5-compact', 'gpt-5.5'],
  ['openai-api-gpt-5.4', 'gpt-5.4'],
  ['openai-api-gpt-5.4-compact', 'gpt-5.4'],
  ['openai-api-gpt-5.4-mini', 'gpt-5.4-mini']
])

export function toOpenAIApiModel(model) {
  if (typeof model !== 'string') return model
  return OPENAI_API_MODEL_MAP.get(model.toLowerCase()) || model
}

// Check if a model should be routed through the OpenAI API channel
// (openai-api-* prefix OR mapped in OPENAI_API_MODEL_MAP)
export function shouldRouteViaOpenAIApi(model) {
  if (typeof model !== 'string') return false
  return model.startsWith('openai-api-') || OPENAI_API_MODEL_MAP.has(model.toLowerCase())
}

// ── Thread route persistence ───────────────────────────────────
export function normalizeRouteModel(model) {
  if (!model || typeof model !== 'string') return null
  const trimmed = model.trim()
  return trimmed || null
}

export function getThreadRouteFile(threadId) {
  if (!threadId) return null
  return path.join(THREAD_ROUTES_DIR, `${threadId}.json`)
}

export function readThreadRouteState(threadId) {
  const routeFile = getThreadRouteFile(threadId)
  if (!routeFile) return { model: null, reasoning_effort: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(routeFile, 'utf8'))
    const effort = ['low', 'medium', 'high', 'xhigh'].includes(parsed.reasoning_effort) ? parsed.reasoning_effort : null
    return { model: normalizeRouteModel(parsed.model), reasoning_effort: effort }
  } catch { return { model: null, reasoning_effort: null } }
}

export function writeThreadRoute(threadId, model, reasoningEffort = null) {
  const routeFile = getThreadRouteFile(threadId)
  if (!routeFile) throw new Error('threadId is required')
  const effort = ['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort) ? reasoningEffort : null
  const payload = { thread_id: threadId, model: normalizeRouteModel(model), reasoning_effort: effort, updated_at: new Date().toISOString() }
  fs.mkdirSync(THREAD_ROUTES_DIR, { recursive: true })
  fs.writeFileSync(routeFile, JSON.stringify(payload, null, 2))
  return payload
}

// ── Request model resolution ───────────────────────────────────
export function parseThreadMetadata(body = {}) {
  const raw = body?.client_metadata?.['x-codex-turn-metadata'] ?? body?.client_metadata?.xCodexTurnMetadata ?? body?.metadata?.['x-codex-turn-metadata'] ?? body?.metadata ?? null
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
}

export function getThreadId(body = {}) {
  const meta = parseThreadMetadata(body)
  return meta.thread_id || meta.threadId || body.thread_id || body.threadId || null
}

export function resolveCodexModel(body = {}) {
  const threadId = getThreadId(body)
  const bodyModel = normalizeRouteModel(body.model)
  const model = bodyModel || proxyConfig.defaultModel
  const bodyEffort = body?.reasoning?.effort || body?.reasoning_effort || null
  return { model, threadId, bodyModel, reasoningEffort: bodyEffort }
}

// ── /v1/models response ────────────────────────────────────────
export function buildModelsResponse(localModels = []) {
  const models = []
  const seen = new Set()
  for (const model of localModels) {
    const slug = model?.slug || model?.id
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    models.push({ ...model, slug })
  }

  function ownedBy(slug) {
    if (slug.startsWith('relay-')) return 'relay'
    if (slug.startsWith('openai-api-')) return 'openai-api'
    if (/^gpt-/i.test(slug)) return 'chatgpt-sub'
    return 'deepseek'
  }

  const data = models.map(model => ({
    id: model.slug, object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: ownedBy(model.slug)
  }))
  return { models, object: 'list', data }
}
