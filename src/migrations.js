import fs from 'node:fs'
import path from 'node:path'

export const CURRENT_CONFIG_SCHEMA = 3
export const CURRENT_STATS_SCHEMA = 2

const DEFAULT_FALLBACK_CHAIN = [
  { provider: 'chatgpt-sub', model: 'gpt-5.6-sol' },
  { provider: 'openai-api', model: 'openai-api-gpt-5.6-sol' },
  { provider: 'deepseek', model: 'deepseek-v4-pro' }
]

function objectDocument(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function cloneDocument(value) {
  return structuredClone(objectDocument(value) ? value : {})
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

export function migrateConfigDocument(document) {
  const migrated = cloneDocument(document)
  const from = Math.max(0, finiteNumber(migrated.schema_version, 0))

  if (!Object.hasOwn(migrated, 'cross_provider_fallback_enabled')) {
    migrated.cross_provider_fallback_enabled = false
  }
  if (!Array.isArray(migrated.fallback_chain)) {
    migrated.fallback_chain = structuredClone(DEFAULT_FALLBACK_CHAIN)
  }
  if (!Array.isArray(migrated.fallback_statuses)) {
    migrated.fallback_statuses = [429, 502, 503, 504]
  }
  if (!objectDocument(migrated.provider_budgets)) {
    migrated.provider_budgets = {}
  }
  migrated.schema_version = CURRENT_CONFIG_SCHEMA

  return {
    document: migrated,
    from,
    to: CURRENT_CONFIG_SCHEMA,
    changed: JSON.stringify(migrated) !== JSON.stringify(document)
  }
}

function migrateCostContainer(value) {
  if (!objectDocument(value)) return
  value.estimated_cost_usd = finiteNumber(value.estimated_cost_usd)
  for (const model of Object.values(value.models || {})) {
    if (objectDocument(model)) model.estimated_cost_usd = finiteNumber(model.estimated_cost_usd)
  }
}

export function migrateStatsDocument(document) {
  const migrated = cloneDocument(document)
  const from = Math.max(0, finiteNumber(migrated.schema_version, 0))
  migrated.updated ||= new Date(0).toISOString()
  migrated.providers = objectDocument(migrated.providers) ? migrated.providers : {}
  migrated.accounts = objectDocument(migrated.accounts) ? migrated.accounts : {}
  migrated.daily = objectDocument(migrated.daily) ? migrated.daily : {}
  migrated.operational_events = Array.isArray(migrated.operational_events)
    ? migrated.operational_events
    : []

  for (const provider of Object.values(migrated.providers)) migrateCostContainer(provider)
  for (const day of Object.values(migrated.daily)) {
    if (!objectDocument(day)) continue
    day.account_attempts = finiteNumber(day.account_attempts)
    day.account_switches = finiteNumber(day.account_switches)
    day.circuit_opens = finiteNumber(day.circuit_opens)
    day.estimated_cost_usd = finiteNumber(day.estimated_cost_usd)
    day.providers = objectDocument(day.providers) ? day.providers : {}
    day.accounts = objectDocument(day.accounts) ? day.accounts : {}
    for (const provider of Object.values(day.providers)) migrateCostContainer(provider)
  }
  migrated.schema_version = CURRENT_STATS_SCHEMA

  return {
    document: migrated,
    from,
    to: CURRENT_STATS_SCHEMA,
    changed: JSON.stringify(migrated) !== JSON.stringify(document)
  }
}

export function backupBeforeMigration(filePath, rawText, {
  from = 0,
  to,
  now = new Date()
} = {}) {
  const directory = path.join(path.dirname(filePath), '.migration-backups')
  fs.mkdirSync(directory, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const name = `${path.basename(filePath)}.schema-${from}-to-${to}.${stamp}.bak`
  const backupPath = path.join(directory, name)
  fs.writeFileSync(backupPath, rawText, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return backupPath
}
