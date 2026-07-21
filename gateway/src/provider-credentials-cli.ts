import { pathToFileURL } from 'node:url'
import { SystemClock } from './common/clock.js'
import { redactText } from './common/redaction.js'
import { loadGatewayConfig, type GatewayConfig } from './config.js'
import {
  createGatewayDatabase,
  type DatabaseHandle
} from './db/database.js'
import { ProviderRepository } from './db/repositories/provider-repository.js'
import {
  ProviderCredentialMaintenanceService,
  type ProviderCredentialMaintenanceReport
} from './security/provider-credential-maintenance.js'
import { ProviderCredentialVault } from './security/provider-credential-vault.js'
import {
  activatePlatformProviderCredentialKeyring,
  loadProviderCredentialKeyring,
  rotatePlatformProviderCredentialKeyring,
  type ProviderCredentialKeyring
} from './security/provider-master-key.js'

type Command = 'verify' | 'migrate' | 'rewrap' | 'rotate-key' | 'activate-key'

interface ParsedArguments {
  readonly command: Command
  readonly dryRun: boolean
  readonly activeKeyId?: string
}

export interface ProviderCredentialCliDependencies {
  readonly config?: GatewayConfig
  readonly database?: DatabaseHandle
  readonly keyring?: ProviderCredentialKeyring
  readonly output?: (value: string) => void
}

function usageError(): Error {
  return new Error(
    'Usage: provider-credentials ' +
    '(--verify | --migrate | --rewrap | --rotate-key | --activate-key KEY_ID) ' +
    '[--dry-run]'
  )
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const commands = new Map<string, Command>([
    ['--verify', 'verify'],
    ['--migrate', 'migrate'],
    ['--rewrap', 'rewrap'],
    ['--rotate-key', 'rotate-key'],
    ['--activate-key', 'activate-key']
  ])
  const selected = argv.filter(value => commands.has(value))
  if (selected.length !== 1) throw usageError()
  const command = commands.get(selected[0] as string) as Command
  const activateIndex = argv.indexOf('--activate-key')
  const activeKeyId = command === 'activate-key'
    ? argv[activateIndex + 1]
    : undefined
  const recognized = new Set([
    '--dry-run',
    selected[0] as string,
    ...(activeKeyId ? [activeKeyId] : [])
  ])
  if (
    argv.length !== 1 + (activeKeyId ? 1 : 0) + (argv.includes('--dry-run') ? 1 : 0) ||
    argv.some(value => !recognized.has(value)) ||
    (command === 'activate-key' && (
      !activeKeyId ||
      activeKeyId.startsWith('-') ||
      !/^[A-Za-z0-9._:-]{1,120}$/.test(activeKeyId)
    ))
  ) {
    throw usageError()
  }
  const dryRun = argv.includes('--dry-run')
  if (
    dryRun &&
    (command === 'verify' || command === 'rotate-key' || command === 'activate-key')
  ) {
    throw usageError()
  }
  return {
    command,
    dryRun,
    ...(activeKeyId ? { activeKeyId } : {})
  }
}

export function providerCredentialCliErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/^(?:Usage:|Provider |Environment\/KMS |Production Provider |AI_EDITOR_GATEWAY_PROVIDER_|Gateway Provider |Windows DPAPI |macOS Keychain )/.test(message)) {
    return redactText(message)
  }
  return 'Provider credential operation failed; sensitive details were suppressed'
}

export async function runProviderCredentialCommand(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: ProviderCredentialCliDependencies = {}
): Promise<ProviderCredentialMaintenanceReport> {
  const parsed = parseArguments(argv)
  const config = dependencies.config || loadGatewayConfig()
  const database = dependencies.database || createGatewayDatabase(config)
  const ownsDatabase = !dependencies.database
  try {
    await database.migrateToLatest()
    const keyring = dependencies.keyring || (
      parsed.command === 'rotate-key'
        ? rotatePlatformProviderCredentialKeyring(config)
        : parsed.command === 'activate-key'
          ? activatePlatformProviderCredentialKeyring(
              config,
              parsed.activeKeyId as string
            )
          : loadProviderCredentialKeyring(config)
    )
    const repository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const maintenance = new ProviderCredentialMaintenanceService(
      repository,
      new ProviderCredentialVault(keyring),
      new SystemClock()
    )
    const report = parsed.command === 'verify'
      ? await maintenance.verify()
      : parsed.command === 'migrate'
        ? await maintenance.migratePlaintext({ dryRun: parsed.dryRun })
        : await maintenance.rewrap({ dryRun: parsed.dryRun })
    dependencies.output?.(`${JSON.stringify({
      ...report,
      ...(parsed.command === 'rotate-key' ? { platformKeyRotated: true } : {}),
      ...(parsed.command === 'activate-key' ? { platformKeyActivated: true } : {})
    }, null, 2)}\n`)
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
    await runProviderCredentialCommand(process.argv.slice(2), {
      output: value => process.stdout.write(value)
    })
  } catch (error) {
    process.stderr.write(
      `[ai-editor-gateway] ${providerCredentialCliErrorMessage(error)}\n`
    )
    process.exitCode = 1
  }
}
