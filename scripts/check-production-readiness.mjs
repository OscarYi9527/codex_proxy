import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FORBIDDEN_KEY_PATTERN = /(api[-_]?key|password|private[-_]?key|refresh[-_]?token|access[-_]?token|client[-_]?secret|signing[-_]?secret|credential)/i
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i
const PENDING_PATTERN = /^(|pending|tbd|todo|replace[-_ ]?me)$/i

export function evaluateProductionReadiness(document) {
  const checks = []
  const add = (id, category, passed, detail) => {
    checks.push({ id, category, status: passed ? 'pass' : 'blocked', detail })
  }

  add(
    'document.schema',
    'document',
    isPlainObject(document) && document.schemaVersion === 1,
    'Decision document uses schemaVersion 1.'
  )
  add(
    'document.no-secrets',
    'document',
    !containsForbiddenKey(document),
    'Decision document contains no credentials, Tokens, passwords or private keys.'
  )
  add(
    'deployment.stage',
    'capacity',
    document?.deploymentStage === 'public-mvp-1-30',
    'Deployment stage is the 1-30 account public MVP.'
  )
  add(
    'deployment.capacity',
    'capacity',
    document?.accountCapacity === 30,
    'Short-term production capacity is fixed at 30 accounts.'
  )

  const gateway = document?.gateway
  add(
    'gateway.cloud',
    'gateway',
    selected(gateway?.hostingProvider) && selected(gateway?.region),
    'Domestic Gateway cloud and region are explicitly selected.'
  )
  add(
    'gateway.capacity',
    'gateway',
    integerAtLeast(gateway?.compute?.vcpu, 4) &&
      integerAtLeast(gateway?.compute?.memoryGiB, 8) &&
      integerAtLeast(gateway?.compute?.storageGiB, 100) &&
      integerAtLeast(gateway?.compute?.bandwidthMbps, 5) &&
      gateway?.compute?.fixedPublicIp === true,
    'Gateway has at least 4 vCPU, 8 GiB RAM, 100 GiB storage, 5 Mbps and a fixed public IP.'
  )
  add(
    'gateway.origin',
    'gateway',
    isProductionHttpsOrigin(gateway?.publicOrigin),
    'Gateway public origin is a stable HTTPS domain origin, not localhost, an IP or Quick Tunnel.'
  )
  add(
    'gateway.icp',
    'gateway',
    gateway?.icpFiling?.required === true && gateway?.icpFiling?.completed === true,
    'Mainland ICP filing is required and completed.'
  )
  add(
    'gateway.waf',
    'gateway',
    selected(gateway?.waf?.product) && gateway?.waf?.configured === true,
    'Production ingress WAF is selected and configured.'
  )
  add(
    'gateway.kms',
    'secrets',
    selected(gateway?.kms?.provider) &&
      selected(gateway?.kms?.adapter) &&
      gateway?.kms?.adapterImplemented === true &&
      gateway?.kms?.rotationTested === true,
    'Gateway KMS provider/adapter are selected, implemented and rotation-tested.'
  )

  const worker = document?.providerWorker
  add(
    'worker.cloud',
    'worker',
    selected(worker?.hostingProvider) &&
      selected(worker?.region) &&
      worker?.providerRegionAuthorized === true,
    'Provider Worker cloud/region are selected and confirmed Provider-authorized.'
  )
  add(
    'worker.capacity',
    'worker',
    integerAtLeast(worker?.compute?.vcpu, 2) &&
      integerAtLeast(worker?.compute?.memoryGiB, 4) &&
      integerAtLeast(worker?.compute?.storageGiB, 40) &&
      worker?.compute?.fixedPublicIp === true,
    'Provider Worker has at least 2 vCPU, 4 GiB RAM, 40 GiB storage and a fixed public IP.'
  )
  add(
    'worker.origin',
    'worker',
    isProductionHttpsOrigin(worker?.origin),
    'Provider Worker uses a stable HTTPS origin.'
  )
  add(
    'worker.mtls',
    'worker',
    worker?.mtls?.enabled === true &&
      worker?.mtls?.rotationTested === true &&
      integerBetween(worker?.mtls?.rotationDays, 1, 90),
    'Gateway-to-Worker mTLS is enabled and rotation-tested at no more than 90 days.'
  )
  add(
    'worker.kms',
    'secrets',
    selected(worker?.kms?.provider) &&
      selected(worker?.kms?.adapter) &&
      worker?.kms?.adapterImplemented === true &&
      worker?.kms?.rotationTested === true,
    'Worker KMS/Secret Manager adapter is selected, implemented and rotation-tested.'
  )

  const database = document?.database
  add(
    'database.postgres',
    'database',
    database?.engine === 'postgresql' &&
      selected(database?.service) &&
      integerBetween(database?.majorVersion, 16, 99),
    'Production database is a selected PostgreSQL 16+ service.'
  )
  add(
    'database.security',
    'database',
    database?.tlsMode === 'verify-full' &&
      database?.leastPrivilegeVerified === true,
    'PostgreSQL uses verify-full TLS and a verified least-privilege identity.'
  )
  add(
    'database.migration',
    'database',
    database?.migrationDryRunPassed === true &&
      database?.rollbackDryRunPassed === true,
    'Production migration and rollback dry runs passed.'
  )

  const backup = document?.backup
  add(
    'backup.off-host',
    'backup',
    selected(backup?.objectStorageProvider) &&
      backup?.offHost === true &&
      backup?.versioningEnabled === true &&
      backup?.encrypted === true,
    'Encrypted, versioned backup storage is selected outside the Gateway host.'
  )
  add(
    'backup.retention',
    'backup',
    integerBetween(backup?.retentionDays, 7, 3650),
    'Backup retention is explicitly set to at least seven days.'
  )
  add(
    'backup.restore',
    'backup',
    backup?.restoreDrillPassed === true,
    'An authenticated off-host restore drill passed.'
  )

  const monitoring = document?.monitoring
  add(
    'monitoring.alerts',
    'operations',
    monitoring?.host === true &&
      monitoring?.disk === true &&
      monitoring?.certificate === true &&
      monitoring?.gateway === true &&
      monitoring?.worker === true &&
      monitoring?.backup === true,
    'Host, disk, certificate, Gateway, Worker and backup alerts are enabled.'
  )

  const source = document?.source
  add(
    'source.pinned',
    'release',
    COMMIT_PATTERN.test(String(source?.gatewayCommit || '')) &&
      COMMIT_PATTERN.test(String(source?.workerCommit || '')) &&
      COMMIT_PATTERN.test(String(source?.codeCommit || '')),
    'Gateway, Worker and Code release commits are pinned to full SHAs.'
  )
  add(
    'release.gates',
    'release',
    source?.releaseCheckPassed === true &&
      source?.secretScanPassed === true &&
      source?.finalEdgeProductPassed === true,
    'Server release, secret scan and final Edge product gates passed.'
  )

  const approvals = document?.approvals
  add(
    'approval.infrastructure',
    'approval',
    approvals?.infrastructureApproved === true,
    'Infrastructure purchase and region selection are approved.'
  )
  add(
    'approval.security',
    'approval',
    approvals?.securityApproved === true,
    'Production security design is approved.'
  )
  add(
    'approval.deployment',
    'approval',
    approvals?.productionDeploymentApproved === true,
    'Production deployment is explicitly approved.'
  )

  const blocked = checks.filter(check => check.status === 'blocked')
  return {
    schemaVersion: 1,
    result: blocked.length === 0 ? 'ready' : 'blocked',
    generatedAt: new Date().toISOString(),
    summary: {
      passed: checks.length - blocked.length,
      blocked: blocked.length,
      total: checks.length
    },
    checks
  }
}

export function readDecisionFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function selected(value) {
  return typeof value === 'string' && !PENDING_PATTERN.test(value.trim())
}

function integerBetween(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

function integerAtLeast(value, minimum) {
  return Number.isInteger(value) && value >= minimum
}

function isProductionHttpsOrigin(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.origin === value &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '::1' &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) &&
      !url.hostname.endsWith('.trycloudflare.com')
  } catch {
    return false
  }
}

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_KEY_PATTERN.test(key) || containsForbiddenKey(child)
  )
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseArguments(argv) {
  const options = {
    config: '',
    report: '',
    reportOnly: false
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--config') {
      options.config = argv[++index] || ''
    } else if (argument === '--report') {
      options.report = argv[++index] || ''
    } else if (argument === '--report-only') {
      options.reportOnly = true
    } else {
      throw new Error(`Unknown production readiness option: ${argument}`)
    }
  }
  if (!options.config) {
    throw new Error('Usage: npm run production:preflight -- --config <decision.json> [--report <report.json>] [--report-only]')
  }
  return options
}

function runCli() {
  const options = parseArguments(process.argv.slice(2))
  const configPath = path.resolve(options.config)
  const report = evaluateProductionReadiness(readDecisionFile(configPath))
  if (options.report) {
    const reportPath = path.resolve(options.report)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8')
  }
  console.log(JSON.stringify({
    result: report.result,
    passed: report.summary.passed,
    blocked: report.summary.blocked,
    total: report.summary.total,
    blockedChecks: report.checks
      .filter(check => check.status === 'blocked')
      .map(check => check.id)
  }, undefined, 2))
  if (report.result !== 'ready' && !options.reportOnly) {
    process.exitCode = 2
  }
}

const isDirectExecution = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectExecution) {
  try {
    runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Production readiness check failed')
    process.exitCode = 1
  }
}
