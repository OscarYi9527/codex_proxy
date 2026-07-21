import { pathToFileURL } from 'node:url'
import { loadGatewayConfig, type GatewayConfig } from './config.js'
import {
  createGatewayDatabase,
  type DatabaseHandle
} from './db/database.js'
import {
  scanGatewayDatabaseSecrets,
  type GatewayDatabaseSecretScanReport
} from './security/database-secret-scan.js'

export async function runGatewaySecretScan(options: {
  config?: GatewayConfig
  database?: DatabaseHandle
  output?: (value: string) => void
} = {}): Promise<GatewayDatabaseSecretScanReport> {
  const config = options.config || loadGatewayConfig()
  const database = options.database || createGatewayDatabase(config)
  const ownsDatabase = !options.database
  try {
    await database.migrateToLatest()
    const report = await scanGatewayDatabaseSecrets(database.db)
    options.output?.(`${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    if (ownsDatabase) await database.close()
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isMain) {
  try {
    const report = await runGatewaySecretScan({
      output: value => process.stdout.write(value)
    })
    if (report.findingCount > 0) process.exitCode = 1
  } catch {
    process.stderr.write(
      '[ai-editor-gateway] Database secret scan failed; sensitive details were suppressed\n'
    )
    process.exitCode = 2
  }
}
