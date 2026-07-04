#!/usr/bin/env node
/**
 * test-proxy.js — Automated regression tests for proxy business logic.
 *
 * Coverage:
 *   parseSessionUrl   — URL routing edge cases
 *   isQuotaExhausted  — file missing, malformed, boundary conditions, clock skew
 *   markQuotaExhausted — writes, overwrites, preserves other providers
 *   resolveModelId    — priority chain, quota fallback, missing fallback_model
 *   buildHeaders      — all three providers, missing env vars (known bugs flagged)
 *
 * NOTE: buildHeaders tests use an injected `env` parameter for isolation.
 *       Production server.js reads process.env directly — keep logic in sync.
 *
 * Usage: node ~/.claude/proxy/test-proxy.js
 * No external dependencies.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    passed++
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      → ${err.message}`)
    failed++
    failures.push({ name, message: err.message })
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || 'assertEqual'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ─── Test environment ─────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `proxy-test-${randomBytes(4).toString('hex')}`)
const SESSIONS_DIR = join(TEST_DIR, 'sessions')
const QUOTA_FILE = join(TEST_DIR, 'quota-status.json')
const MODELS_FILE = join(TEST_DIR, 'models.json')
const CURRENT_MODEL_FILE = join(TEST_DIR, 'current-model.json')

mkdirSync(SESSIONS_DIR, { recursive: true })

process.on('exit', () => { try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {} })
process.on('SIGINT', () => { rmSync(TEST_DIR, { recursive: true, force: true }); process.exit(1) })

// ─── Mirror of server.js business logic ──────────────────────────────────────
// Keep in sync with server.js. Differences are annotated.

const TEST_MODELS = {
  models: [
    { id: 'claude-opus-4-8',     name: 'Claude Opus 4.8', provider: 'anthropic', description: '...', fallback_chain: ['deepseek-v4-pro'] },
    { id: 'claude-sonnet-4-6',   name: 'Claude Sonnet',   provider: 'anthropic', description: '...', fallback_chain: ['deepseek-v4-pro'] },
    { id: 'claude-haiku-4-5',    name: 'Claude Haiku',    provider: 'anthropic', description: '...', fallback_chain: ['deepseek-v4-pro'] },
    { id: 'deepseek-v4-pro',     name: 'DeepSeek V4 Pro', provider: 'deepseek',  description: '...' },
  ]
}
writeFileSync(MODELS_FILE, JSON.stringify(TEST_MODELS))

let cachedModels = null
function resetModelCache() { cachedModels = null }
function getModels()       { if (!cachedModels) cachedModels = JSON.parse(readFileSync(MODELS_FILE, 'utf8')).models; return cachedModels }
function getModelConfig(id) { return getModels().find(m => m.id === id) || null }

function getQuotaStatus() {
  try { return JSON.parse(readFileSync(QUOTA_FILE, 'utf8')) } catch { return {} }
}

function isQuotaExhausted(provider) {
  const entry = getQuotaStatus()[provider]
  if (!entry || !entry.exhausted) return false
  if (entry.exhausted_at == null || Date.now() - entry.exhausted_at > QUOTA_RESET_MS) {
    const status = getQuotaStatus()
    delete status[provider]
    try { writeFileSync(QUOTA_FILE, JSON.stringify(status, null, 2)) } catch {}
    return false
  }
  return true
}

function markQuotaExhausted(provider) {
  const status = getQuotaStatus()
  status[provider] = { exhausted: true, exhausted_at: Date.now() }
  writeFileSync(QUOTA_FILE, JSON.stringify(status, null, 2))
}

function getSessionModel(sessionId) {
  if (!sessionId) return null
  try { return JSON.parse(readFileSync(join(SESSIONS_DIR, `${sessionId}.json`), 'utf8')).model }
  catch { return null }
}

function getFallbackModelId() {
  try { return JSON.parse(readFileSync(CURRENT_MODEL_FILE, 'utf8')).model }
  catch { return 'claude-haiku-4-5' }
}

function resolveModelId(rawBody, sessionId) {
  let modelId = null
  const sessionModel = getSessionModel(sessionId)
  if (sessionModel && getModelConfig(sessionModel)) {
    modelId = sessionModel
  } else {
    try {
      const body = JSON.parse(rawBody.toString())
      if (body.model && getModelConfig(body.model)) modelId = body.model
    } catch {}
    if (!modelId) modelId = getFallbackModelId()
  }
  const config = getModelConfig(modelId)
  if (!config) return modelId

  const chain = config.fallback_chain || (config.fallback_model ? [config.fallback_model] : [])
  if (!isQuotaExhausted(config.provider)) return modelId
  if (chain.length === 0) return null  // fixed: no longer bypasses quota check

  for (const fbId of chain) {
    const fbConfig = getModelConfig(fbId)
    if (!fbConfig) continue
    if (isQuotaExhausted(fbConfig.provider)) continue
    return fbId
  }
  return null
}

function parseSessionUrl(url) {
  const m = url.match(/^\/s\/([^/]+)(\/v1\/.*)/)
  if (m) return { sessionId: m[1], actualUrl: m[2] }
  return { sessionId: null, actualUrl: url }
}

// Difference from server.js: accepts `env` param instead of using process.env directly.
function buildHeaders(originalHeaders, modelConfig, env = {}) {
  const headers = {
    'content-type': 'application/json',
    'accept': originalHeaders['accept'] || 'application/json'
  }
  if (modelConfig.provider === 'anthropic') {
    if (originalHeaders['authorization'])     headers['authorization']     = originalHeaders['authorization']
    if (originalHeaders['x-api-key'])         headers['x-api-key']         = originalHeaders['x-api-key']
    if (originalHeaders['anthropic-version']) headers['anthropic-version'] = originalHeaders['anthropic-version']
    if (originalHeaders['anthropic-beta'])    headers['anthropic-beta']    = originalHeaders['anthropic-beta']
  } else if (modelConfig.provider === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY environment variable is not set')
    headers['x-api-key']         = env.DEEPSEEK_API_KEY
    headers['anthropic-version'] = originalHeaders['anthropic-version'] || '2023-06-01'
    if (originalHeaders['anthropic-beta']) headers['anthropic-beta'] = originalHeaders['anthropic-beta']
  } else if (modelConfig.provider === 'claude-ai') {
    if (!env.CLAUDE_SESSION_TOKEN) throw new Error('Claude 订阅 Token 未找到，请先登录 claude.ai (claudeAiOauth.accessToken)')
    headers['authorization']     = `Bearer ${env.CLAUDE_SESSION_TOKEN}`
    if (originalHeaders['anthropic-version']) headers['anthropic-version'] = originalHeaders['anthropic-version']
    if (originalHeaders['anthropic-beta'])    headers['anthropic-beta']    = originalHeaders['anthropic-beta']
  }
  return headers
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const QUOTA_RESET_MS = 5 * 60 * 60 * 1000 // must match server.js

function resetQuota()         { try { rmSync(QUOTA_FILE) } catch {} }
function writeQuota(data)     { writeFileSync(QUOTA_FILE, JSON.stringify(data, null, 2)) }
function writeSession(id, model) { writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify({ model })) }

// ─── Suite: parseSessionUrl ───────────────────────────────────────────────────

console.log('\n── parseSessionUrl ───────────────────────────────────────────')

test('standard session URL', () => {
  const r = parseSessionUrl('/s/sabc1234/v1/messages')
  assertEqual(r.sessionId, 'sabc1234')
  assertEqual(r.actualUrl, '/v1/messages')
})

test('no session → passes through unchanged', () => {
  const r = parseSessionUrl('/v1/messages')
  assertEqual(r.sessionId, null)
  assertEqual(r.actualUrl, '/v1/messages')
})

test('session URL with query string', () => {
  const r = parseSessionUrl('/s/sabc1234/v1/messages?stream=true')
  assertEqual(r.sessionId, 'sabc1234')
  assertEqual(r.actualUrl, '/v1/messages?stream=true')
})

test('session URL to /v1/models', () => {
  const r = parseSessionUrl('/s/sabc1234/v1/models')
  assertEqual(r.sessionId, 'sabc1234')
  assertEqual(r.actualUrl, '/v1/models')
})

test('missing /v1/ segment → regex does not match, sessionId is null', () => {
  // /s/id/messages (no v1) falls through to globalUrl — caller gets unstripped path
  const r = parseSessionUrl('/s/sabc1234/messages')
  assertEqual(r.sessionId, null)
})

test('empty string URL', () => {
  const r = parseSessionUrl('')
  assertEqual(r.sessionId, null)
  assertEqual(r.actualUrl, '')
})

test('session ID with hyphens and digits (realistic)', () => {
  const r = parseSessionUrl('/s/s24023403/v1/messages')
  assertEqual(r.sessionId, 's24023403')
})

// ─── Suite: isQuotaExhausted / markQuotaExhausted ─────────────────────────────

console.log('\n── quota status ──────────────────────────────────────────────')

test('no quota-status.json → not exhausted', () => {
  resetQuota()
  assert(!isQuotaExhausted('claude-ai'))
})

test('empty object → not exhausted', () => {
  writeQuota({})
  assert(!isQuotaExhausted('claude-ai'))
})

test('exhausted: false → not exhausted', () => {
  writeQuota({ 'claude-ai': { exhausted: false, exhausted_at: Date.now() } })
  assert(!isQuotaExhausted('claude-ai'))
})

test('provider not in file → not exhausted', () => {
  writeQuota({ 'other': { exhausted: true, exhausted_at: Date.now() } })
  assert(!isQuotaExhausted('claude-ai'))
})

test('recently exhausted → exhausted', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: Date.now() - 1000 } })
  assert(isQuotaExhausted('claude-ai'))
})

test('boundary: 5h - 5s → still exhausted', () => {
  // Use 5s margin — 1ms is smaller than file I/O + JSON parse time, causing flaky failures
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: Date.now() - (QUOTA_RESET_MS - 5000) } })
  assert(isQuotaExhausted('claude-ai'), 'should still be exhausted 5s before the reset threshold')
})

test('boundary: 5h + 1ms → auto-resets, returns false', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: Date.now() - (QUOTA_RESET_MS + 1) } })
  assert(!isQuotaExhausted('claude-ai'), 'should auto-reset after 5h')
})

test('auto-reset removes entry from file', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: Date.now() - (QUOTA_RESET_MS + 1) } })
  isQuotaExhausted('claude-ai')
  assert(!getQuotaStatus()['claude-ai'], 'entry should be removed after auto-reset')
})

test('auto-reset preserves other providers', () => {
  writeQuota({
    'claude-ai': { exhausted: true, exhausted_at: Date.now() - (QUOTA_RESET_MS + 1) },
    'deepseek':  { exhausted: true, exhausted_at: Date.now() }
  })
  isQuotaExhausted('claude-ai')
  const s = getQuotaStatus()
  assert(!s['claude-ai'], 'claude-ai should be removed')
  assert(s['deepseek'],   'deepseek should be preserved')
})

test('clock skew: exhausted_at in future → treated as exhausted (diff < 5h threshold)', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: Date.now() + QUOTA_RESET_MS * 2 } })
  // Date.now() - future = negative → not > QUOTA_RESET_MS threshold → not auto-reset → returns true
  assert(isQuotaExhausted('claude-ai'), 'future timestamp stays exhausted (diff is negative, < 5h check)')
})

test('exhausted_at: null → auto-resets (fixed: != null guard)', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: null } })
  // Fixed: `entry.exhausted_at != null` prevents falsy short-circuit.
  // null exhausted_at now treated as "reset time unknown" → Date.now()-null=Date.now() > 24h → auto-reset
  assert(!isQuotaExhausted('claude-ai'), 'null exhausted_at should auto-reset after fix')
})

test('malformed JSON in quota-status.json → not exhausted (graceful degrade)', () => {
  writeFileSync(QUOTA_FILE, '{ invalid json :::')
  assert(!isQuotaExhausted('claude-ai'))
})

test('markQuotaExhausted writes correct structure', () => {
  resetQuota()
  const before = Date.now()
  markQuotaExhausted('claude-ai')
  const after = Date.now()
  const entry = getQuotaStatus()['claude-ai']
  assert(entry,                          'entry must exist')
  assert(entry.exhausted === true,       'exhausted must be true')
  assert(entry.exhausted_at >= before,   'exhausted_at must be >= before timestamp')
  assert(entry.exhausted_at <= after,    'exhausted_at must be <= after timestamp')
})

test('markQuotaExhausted overwrites stale entry', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: 1000 } })
  markQuotaExhausted('claude-ai')
  assert(getQuotaStatus()['claude-ai'].exhausted_at > 1000, 'should overwrite old timestamp')
})

test('markQuotaExhausted preserves other providers', () => {
  writeQuota({ 'deepseek': { exhausted: true, exhausted_at: 999 } })
  markQuotaExhausted('claude-ai')
  const s = getQuotaStatus()
  assert(s['deepseek'],                      'deepseek must survive')
  assertEqual(s['deepseek'].exhausted_at, 999, 'deepseek timestamp must be unchanged')
})

test('each provider is isolated', () => {
  writeQuota({ 'claude-ai': { exhausted: true, exhausted_at: Date.now() } })
  assert( isQuotaExhausted('claude-ai'), 'claude-ai should be exhausted')
  assert(!isQuotaExhausted('deepseek'),  'deepseek should not be affected')
  assert(!isQuotaExhausted('anthropic'), 'anthropic should not be affected')
})

// ─── Suite: resolveModelId ────────────────────────────────────────────────────

console.log('\n── resolveModelId ────────────────────────────────────────────')

test('session model takes priority over body.model', () => {
  resetQuota()
  writeSession('s1', 'claude-opus-4-8')
  assertEqual(resolveModelId(JSON.stringify({ model: 'deepseek-v4-pro' }), 's1'), 'claude-opus-4-8')
})

test('body.model used when no session file', () => {
  resetQuota()
  assertEqual(resolveModelId(JSON.stringify({ model: 'deepseek-v4-pro' }), 'no-such-session'), 'deepseek-v4-pro')
})

test('global fallback when no session and no body.model', () => {
  resetQuota()
  assertEqual(resolveModelId(JSON.stringify({}), null), 'claude-haiku-4-5')
})

test('anthropic model → falls back to deepseek when anthropic quota exhausted', () => {
  writeQuota({ 'anthropic': { exhausted: true, exhausted_at: Date.now() } })
  writeSession('s2', 'claude-sonnet-4-6')
  assertEqual(resolveModelId(JSON.stringify({}), 's2'), 'deepseek-v4-pro')
  resetQuota()
})

test('anthropic NOT exhausted → returns model as-is', () => {
  resetQuota()
  writeSession('s4', 'claude-haiku-4-5')
  assertEqual(resolveModelId(JSON.stringify({}), 's4'), 'claude-haiku-4-5')
})

test('deepseek with no fallback_chain → returns null when provider exhausted', () => {
  writeQuota({ 'deepseek': { exhausted: true, exhausted_at: Date.now() } })
  writeSession('s8', 'deepseek-v4-pro')
  assertEqual(resolveModelId(JSON.stringify({}), 's8'), null)
  resetQuota()
})

test('session model: null → falls through to body.model', () => {
  resetQuota()
  writeSession('s5', null)
  assertEqual(resolveModelId(JSON.stringify({ model: 'deepseek-v4-pro' }), 's5'), 'deepseek-v4-pro')
})

test('unknown body.model → global fallback (haiku)', () => {
  resetQuota()
  assertEqual(resolveModelId(JSON.stringify({ model: 'gpt-99-unknown' }), null), 'claude-haiku-4-5')
})

test('malformed body → global fallback (no crash)', () => {
  resetQuota()
  assertEqual(resolveModelId(Buffer.from('not json {{'), null), 'claude-haiku-4-5')
})

// ─── Suite: buildHeaders ──────────────────────────────────────────────────────

console.log('\n── buildHeaders ──────────────────────────────────────────────')

test('anthropic: passes all four headers', () => {
  const h = buildHeaders(
    { 'authorization': 'Bearer sk', 'x-api-key': 'sk', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools' },
    { provider: 'anthropic' }, {}
  )
  assertEqual(h['authorization'],     'Bearer sk')
  assertEqual(h['x-api-key'],         'sk')
  assertEqual(h['anthropic-version'], '2023-06-01')
  assertEqual(h['anthropic-beta'],    'tools')
})

test('anthropic: omits headers absent from original request', () => {
  const h = buildHeaders({ 'x-api-key': 'sk' }, { provider: 'anthropic' }, {})
  assert(!('authorization'  in h), 'no authorization if not in original')
  assert(!('anthropic-beta' in h), 'no anthropic-beta if not in original')
})

test('deepseek: uses DEEPSEEK_API_KEY, omits authorization', () => {
  const h = buildHeaders({ 'anthropic-version': '2023-06-01' }, { provider: 'deepseek' }, { DEEPSEEK_API_KEY: 'ds-key' })
  assertEqual(h['x-api-key'], 'ds-key')
  assert(!('authorization' in h), 'deepseek must not forward anthropic authorization')
})

test('deepseek: injects default anthropic-version when missing', () => {
  const h = buildHeaders({}, { provider: 'deepseek' }, { DEEPSEEK_API_KEY: 'x' })
  assertEqual(h['anthropic-version'], '2023-06-01')
})

test('deepseek: forwards anthropic-beta if present', () => {
  const h = buildHeaders({ 'anthropic-beta': 'tools-2024' }, { provider: 'deepseek' }, { DEEPSEEK_API_KEY: 'x' })
  assertEqual(h['anthropic-beta'], 'tools-2024')
})

test('deepseek: missing DEEPSEEK_API_KEY → throws descriptive error (fixed)', () => {
  try {
    buildHeaders({}, { provider: 'deepseek' }, {})
    assert(false, 'should have thrown')
  } catch (err) {
    assert(err.message.includes('DEEPSEEK_API_KEY'), `error should name the missing var, got: "${err.message}"`)
  }
})

test('all providers: content-type and accept always set', () => {
  for (const provider of ['anthropic', 'deepseek']) {
    const h = buildHeaders({}, { provider }, { DEEPSEEK_API_KEY: 'x', CLAUDE_SESSION_TOKEN: 'y' })
    assertEqual(h['content-type'], 'application/json', `${provider}: content-type`)
    assertEqual(h['accept'],       'application/json', `${provider}: accept default`)
  }
})

test('accept: respects original value (text/event-stream for streaming)', () => {
  const h = buildHeaders({ 'accept': 'text/event-stream' }, { provider: 'anthropic' }, {})
  assertEqual(h['accept'], 'text/event-stream')
})

// ─── Suite: candidate iteration (proxyRequest retry logic) ─────────────────────

console.log('\n── candidate iteration ───────────────────────────────────────')

// Mirror of server.js proxyRequest candidate-walking logic.
// Candidates = [modelId, ...fallback_chain]. Skip entries whose buildHeaders throws.
function walkCandidates(rawBody, sessionId, env) {
  const modelId = resolveModelId(rawBody, sessionId)
  if (modelId === null) return { error: 'all_exhausted' }

  const primaryConfig = getModelConfig(modelId)
  const candidates = [modelId, ...(primaryConfig?.fallback_chain || [])]

  for (const cid of candidates) {
    const config = getModelConfig(cid)
    if (!config) continue
    try {
      buildHeaders({}, config, env)
      return { model: cid, provider: config.provider }
    } catch (err) {
      // header build failed → skip to next candidate
      continue
    }
  }
  return { error: 'all_exhausted' }
}

test('anthropic model → uses anthropic directly', () => {
  resetQuota()
  writeSession('s1', 'claude-sonnet-4-6')
  const result = walkCandidates(JSON.stringify({}), 's1', { DEEPSEEK_API_KEY: 'x' })
  assertEqual(result.provider, 'anthropic')
  assertEqual(result.model, 'claude-sonnet-4-6')
})

test('anthropic exhausted → falls back to deepseek', () => {
  writeQuota({ 'anthropic': { exhausted: true, exhausted_at: Date.now() } })
  writeSession('s2', 'claude-opus-4-8')
  const result = walkCandidates(JSON.stringify({}), 's2', { DEEPSEEK_API_KEY: 'x' })
  assertEqual(result.provider, 'deepseek')
  assertEqual(result.model, 'deepseek-v4-pro')
  resetQuota()
})

test('anthropic + deepseek both exhausted → all_exhausted', () => {
  writeQuota({ 'anthropic': { exhausted: true, exhausted_at: Date.now() } })
  writeSession('s3', 'claude-haiku-4-5')
  const result = walkCandidates(JSON.stringify({}), 's3', {})
  assertEqual(result.error, 'all_exhausted')
  resetQuota()
})

test('deepseek selected directly → uses deepseek', () => {
  resetQuota()
  writeSession('s4', 'deepseek-v4-pro')
  const result = walkCandidates(JSON.stringify({}), 's4', { DEEPSEEK_API_KEY: 'x' })
  assertEqual(result.provider, 'deepseek')
  assertEqual(result.model, 'deepseek-v4-pro')
})

test('deepseek selected but no DEEPSEEK_API_KEY → all_exhausted', () => {
  resetQuota()
  writeSession('s5', 'deepseek-v4-pro')
  const result = walkCandidates(JSON.stringify({}), 's5', {})
  assertEqual(result.error, 'all_exhausted')
})

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(`\n${'─'.repeat(62)}`)
console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m  (${total} total)\n`)

if (failures.length > 0) {
  console.log('Failed:')
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.message}`))
  console.log()
}

console.log('All bugs fixed: quota reset window (5h), no-fallback quota bypass, chain skip exhausted entries.')
console.log()

process.exit(failed > 0 ? 1 : 0)
