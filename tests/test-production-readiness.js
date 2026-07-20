import { describe, it } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateProductionReadiness, readDecisionFile } from '../scripts/check-production-readiness.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function completeDecision() {
  return {
    schemaVersion: 1,
    deploymentStage: 'public-mvp-1-30',
    accountCapacity: 30,
    gateway: {
      hostingProvider: 'domestic-cloud',
      region: 'mainland-region',
      publicOrigin: 'https://gateway.cocoduck.live',
      compute: {
        vcpu: 4,
        memoryGiB: 8,
        storageGiB: 100,
        bandwidthMbps: 10,
        fixedPublicIp: true
      },
      icpFiling: { required: true, completed: true },
      waf: { product: 'SafeLine Community Edition', configured: true },
      kms: {
        provider: 'domestic-kms',
        adapter: 'gateway-kms-v1',
        adapterImplemented: true,
        rotationTested: true
      }
    },
    providerWorker: {
      hostingProvider: 'authorized-cloud',
      region: 'provider-authorized-region',
      providerRegionAuthorized: true,
      origin: 'https://worker.cocoduck.live',
      compute: {
        vcpu: 2,
        memoryGiB: 4,
        storageGiB: 40,
        fixedPublicIp: true
      },
      mtls: { enabled: true, rotationDays: 60, rotationTested: true },
      kms: {
        provider: 'authorized-secret-manager',
        adapter: 'worker-secret-manager-v1',
        adapterImplemented: true,
        rotationTested: true
      }
    },
    database: {
      engine: 'postgresql',
      service: 'production-postgres',
      majorVersion: 16,
      tlsMode: 'verify-full',
      leastPrivilegeVerified: true,
      migrationDryRunPassed: true,
      rollbackDryRunPassed: true
    },
    backup: {
      objectStorageProvider: 'versioned-object-storage',
      offHost: true,
      versioningEnabled: true,
      encrypted: true,
      retentionDays: 30,
      restoreDrillPassed: true
    },
    monitoring: {
      host: true,
      disk: true,
      certificate: true,
      gateway: true,
      worker: true,
      backup: true
    },
    source: {
      gatewayCommit: 'a'.repeat(40),
      workerCommit: 'b'.repeat(40),
      codeCommit: 'c'.repeat(40),
      releaseCheckPassed: true,
      secretScanPassed: true,
      finalEdgeProductPassed: true
    },
    approvals: {
      infrastructureApproved: true,
      securityApproved: true,
      productionDeploymentApproved: true
    }
  }
}

describe('production readiness gate', () => {
  it('keeps the committed example blocked without exposing secrets', () => {
    const example = readDecisionFile(path.join(
      repositoryRoot,
      'deploy',
      'production',
      'readiness.example.json'
    ))
    const report = evaluateProductionReadiness(example)
    assert.strictEqual(report.result, 'blocked')
    assert.ok(report.summary.blocked > 0)
    assert.strictEqual(
      report.checks.find(check => check.id === 'document.no-secrets')?.status,
      'pass'
    )
  })

  it('accepts a fully recorded 30-account production decision', () => {
    const report = evaluateProductionReadiness(completeDecision())
    assert.strictEqual(report.result, 'ready')
    assert.strictEqual(report.summary.blocked, 0)
    assert.strictEqual(report.summary.passed, report.summary.total)
  })

  it('rejects Quick Tunnel, missing approvals and secret-shaped fields', () => {
    const decision = completeDecision()
    decision.gateway.publicOrigin = 'https://temporary-preview.trycloudflare.com'
    decision.approvals.productionDeploymentApproved = false
    decision.gateway.databasePassword = 'must-not-be-recorded'
    const report = evaluateProductionReadiness(decision)
    const blocked = new Set(
      report.checks
        .filter(check => check.status === 'blocked')
        .map(check => check.id)
    )
    assert.ok(blocked.has('document.no-secrets'))
    assert.ok(blocked.has('gateway.origin'))
    assert.ok(blocked.has('approval.deployment'))
  })

  it('does not write a complete decision fixture to disk', () => {
    const serialized = JSON.stringify(completeDecision())
    assert.ok(!/password|token|privateKey|apiKey|clientSecret/i.test(serialized))
    assert.ok(fs.existsSync(path.join(repositoryRoot, 'deploy', 'production', 'README.md')))
  })
})
