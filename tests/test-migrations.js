import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  backupBeforeMigration,
  CURRENT_CONFIG_SCHEMA,
  CURRENT_STATS_SCHEMA,
  migrateConfigDocument,
  migrateStatsDocument
} from '../src/migrations.js'

describe('versioned document migrations', () => {
  it('migrates legacy configuration idempotently and preserves unknown fields', () => {
    const legacy = { default_model: 'legacy-model', future_extension: { enabled: true } }
    const first = migrateConfigDocument(legacy)
    assert.equal(first.changed, true)
    assert.equal(first.document.schema_version, CURRENT_CONFIG_SCHEMA)
    assert.equal(first.document.cross_provider_fallback_enabled, false)
    assert.deepEqual(first.document.fallback_statuses, [429, 502, 503, 504])
    assert.deepEqual(first.document.provider_budgets, {})
    assert.deepEqual(first.document.future_extension, { enabled: true })

    const second = migrateConfigDocument(first.document)
    assert.equal(second.changed, false)
    assert.deepEqual(second.document, first.document)
  })

  it('adds cost and operational fields to legacy statistics idempotently', () => {
    const legacy = {
      updated: '2026-01-01T00:00:00.000Z',
      providers: { relay: { requests: 2, models: { m: { requests: 2 } } } },
      daily: { '2026-01-01': { requests: 2, providers: { relay: { requests: 2 } } } },
      custom_rollup: { retained: true }
    }
    const first = migrateStatsDocument(legacy)
    assert.equal(first.document.schema_version, CURRENT_STATS_SCHEMA)
    assert.equal(first.document.providers.relay.estimated_cost_usd, 0)
    assert.equal(first.document.providers.relay.models.m.estimated_cost_usd, 0)
    assert.equal(first.document.daily['2026-01-01'].account_switches, 0)
    assert.equal(first.document.daily['2026-01-01'].circuit_opens, 0)
    assert.deepEqual(first.document.custom_rollup, { retained: true })
    assert.equal(migrateStatsDocument(first.document).changed, false)
  })

  it('writes a byte-for-byte backup before a migrated document is replaced', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migration-'))
    try {
      const file = path.join(directory, 'config.json')
      const raw = '{\"legacy\":true}\\n'
      fs.writeFileSync(file, raw)
      const backup = backupBeforeMigration(file, raw, {
        from: 0,
        to: CURRENT_CONFIG_SCHEMA,
        now: new Date('2026-01-02T03:04:05.000Z')
      })
      assert.equal(fs.readFileSync(backup, 'utf8'), raw)
      assert.match(backup, /schema-0-to-3/)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a migration backup containing an unprotected secret', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migration-secret-'))
    try {
      const file = path.join(directory, 'unsafe.json')
      const raw = JSON.stringify({
        access_token: `access_${'x'.repeat(32)}`
      })
      assert.throws(() => backupBeforeMigration(file, raw, {
        from: 0,
        to: 1,
        now: new Date('2026-07-21T00:00:00.000Z')
      }), /Migration backup contains an unprotected secret/)
      assert.equal(fs.existsSync(path.join(directory, '.migration-backups')), false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
