import type { Kysely } from 'kysely'
import type { GatewayDatabase } from '../db/schema.js'
import {
  isProviderCredentialEnvelope,
  scanTextSecrets,
  scanValueSecrets,
  type SecretFinding
} from '../../../src/secret-scan.js'

export interface GatewayDatabaseSecretScanReport {
  readonly version: 1
  readonly scannedRecords: number
  readonly findingCount: number
  readonly findings: readonly SecretFinding[]
}

const MAX_FINDINGS = 100

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function scanStoredValue(
  findings: SecretFinding[],
  value: unknown,
  source: string,
  path: string
): void {
  if (findings.length >= MAX_FINDINGS) return
  findings.push(...(
    typeof value === 'string'
      ? scanTextSecrets(value, {
          source,
          path,
          maxFindings: MAX_FINDINGS - findings.length
        })
      : scanValueSecrets(value, {
          source,
          path,
          maxFindings: MAX_FINDINGS - findings.length
        })
  ))
}

function manualFinding(
  kind: string,
  source: string,
  path: string
): SecretFinding {
  return {
    version: 1,
    kind,
    source,
    path
  }
}

export async function scanGatewayDatabaseSecrets(
  db: Kysely<GatewayDatabase>
): Promise<GatewayDatabaseSecretScanReport> {
  const findings: SecretFinding[] = []
  let scannedRecords = 0

  const credentials = await db
    .selectFrom('provider_credentials')
    .select(['storage_kind', 'secret_payload'])
    .execute()
  for (const [index, credential] of credentials.entries()) {
    scannedRecords += 1
    const path = `provider_credentials[${index}]`
    if (credential.storage_kind !== 'envelope-v1') {
      if (findings.length < MAX_FINDINGS) {
        findings.push(manualFinding(
          'provider-plaintext-credential',
          'gateway-database',
          `${path}.secret_payload`
        ))
      }
      continue
    }
    const envelope = parseJson(credential.secret_payload)
    if (!isProviderCredentialEnvelope(envelope)) {
      if (findings.length < MAX_FINDINGS) {
        findings.push(manualFinding(
          'provider-invalid-envelope',
          'gateway-database',
          `${path}.secret_payload`
        ))
      }
    }
  }

  const providers = await db
    .selectFrom('providers')
    .select('config_json')
    .execute()
  for (const [index, provider] of providers.entries()) {
    scannedRecords += 1
    scanStoredValue(
      findings,
      parseJson(provider.config_json),
      'gateway-database',
      `providers[${index}].config_json`
    )
  }

  const routes = await db
    .selectFrom('model_routes')
    .select('policy_json')
    .execute()
  for (const [index, route] of routes.entries()) {
    scannedRecords += 1
    scanStoredValue(
      findings,
      parseJson(route.policy_json),
      'gateway-database',
      `model_routes[${index}].policy_json`
    )
  }

  const audits = await db
    .selectFrom('admin_audit_events')
    .select('safe_metadata_json')
    .execute()
  for (const [index, audit] of audits.entries()) {
    scannedRecords += 1
    scanStoredValue(
      findings,
      parseJson(audit.safe_metadata_json),
      'gateway-database',
      `admin_audit_events[${index}].safe_metadata_json`
    )
  }

  const conversations = await db
    .selectFrom('conversation_audits')
    .select(['user_text_sanitized', 'assistant_text_sanitized'])
    .execute()
  for (const [index, conversation] of conversations.entries()) {
    scannedRecords += 1
    for (const field of ['user_text_sanitized', 'assistant_text_sanitized'] as const) {
      const value = conversation[field]
      if (!value) continue
      scanStoredValue(
        findings,
        value,
        'gateway-database',
        `conversation_audits[${index}].${field}`
      )
    }
  }

  const metadata = await db
    .selectFrom('gateway_meta')
    .select('value')
    .execute()
  for (const [index, item] of metadata.entries()) {
    scannedRecords += 1
    scanStoredValue(
      findings,
      parseJson(item.value),
      'gateway-database',
      `gateway_meta[${index}].value`
    )
  }

  return {
    version: 1,
    scannedRecords,
    findingCount: findings.length,
    findings
  }
}

export async function assertGatewayDatabaseSecretsSafe(
  db: Kysely<GatewayDatabase>
): Promise<GatewayDatabaseSecretScanReport> {
  const report = await scanGatewayDatabaseSecrets(db)
  if (report.findingCount > 0) {
    const kinds = [...new Set(report.findings.map(item => item.kind))].sort()
    throw new Error(
      `Gateway database secret scan failed with ${report.findingCount} finding(s): ` +
      kinds.join(', ')
    )
  }
  return report
}
