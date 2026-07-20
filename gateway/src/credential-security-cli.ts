import fs from 'node:fs'
import path from 'node:path'
import { SystemClock } from './common/clock.js'
import { CryptoIdSource } from './common/ids.js'
import { loadGatewayConfig } from './config.js'
import { createGatewayDatabase } from './db/database.js'
import { ProviderRepository } from './db/repositories/provider-repository.js'
import { CredentialMigrationService } from './providers/credential-migration-service.js'
import {
  DevelopmentFileCredentialKeyProvider
} from './security/credential-keys.js'
import { EncryptedSqliteBackupService } from './security/encrypted-sqlite-backup.js'
import { EnvelopeCredentialProtector } from './security/envelope-credential-protector.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requireLocalSqlite(config: ReturnType<typeof loadGatewayConfig>): void {
  if (config.environment === 'production') {
    throw new Error(
      'This local CLI cannot replace the production KMS/Secret Manager migration runner'
    )
  }
  if (config.database.dialect !== 'sqlite') {
    throw new Error('The local credential security CLI currently supports SQLite only')
  }
}

function backupPath(dataRoot: string, operation: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  return path.join(
    dataRoot,
    'credential-backups',
    `${timestamp}-${operation}.gateway-backup`
  )
}

async function main(): Promise<void> {
  const operation = process.argv[2] || 'status'
  if (!['status', 'verify', 'backup', 'restore', 'migrate', 'rotate'].includes(operation)) {
    throw new Error(`Unsupported credential security operation: ${operation}`)
  }
  const config = loadGatewayConfig()
  requireLocalSqlite(config)
  const keys = new DevelopmentFileCredentialKeyProvider(config.dataRoot)
  const backups = new EncryptedSqliteBackupService(keys)

  if (operation === 'restore') {
    const source = argument('--source')
    const destination = argument('--destination')
    if (!source || !destination) {
      throw new Error('restore requires --source and --destination')
    }
    await backups.restore(path.resolve(source), path.resolve(destination))
    console.log(JSON.stringify({
      operation,
      status: 'restored',
      destination: path.resolve(destination)
    }))
    return
  }

  if (operation === 'backup') {
    if (!fs.existsSync(config.database.sqliteFile)) {
      throw new Error('Gateway SQLite database does not exist')
    }
    const destination = path.resolve(
      argument('--destination') || backupPath(config.dataRoot, operation)
    )
    console.log(JSON.stringify({
      operation,
      ...await backups.create(config.database.sqliteFile, destination)
    }))
    return
  }

  const mutatesCredentials = ['migrate', 'rotate'].includes(operation)
  if (mutatesCredentials && !fs.existsSync(config.database.sqliteFile)) {
    throw new Error('Gateway SQLite database does not exist')
  }
  const preMutationBackup = mutatesCredentials
    ? await backups.create(
        config.database.sqliteFile,
        backupPath(config.dataRoot, operation)
      )
    : null
  const database = createGatewayDatabase(config)
  try {
    await database.migrateToLatest()
    const protector = new EnvelopeCredentialProtector(keys)
    const repository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      protector
    )
    const migration = new CredentialMigrationService(
      repository,
      new SystemClock(),
      new CryptoIdSource()
    )
    const level1 = await database.db.selectFrom('accounts')
      .select('id')
      .where('role', '=', 'level1')
      .where('status', '=', 'active')
      .orderBy('created_at', 'asc')
      .executeTakeFirst()

    if (operation === 'status') {
      console.log(JSON.stringify({
        operation,
        plaintextCredentials: await repository.countPlaintextCredentials(),
        envelopeCredentials: await repository.countEnvelopeCredentials(),
        currentKeyVersion: await keys.currentKeyVersion()
      }))
      return
    }
    if (operation === 'verify') {
      console.log(JSON.stringify({
        operation,
        ...await migration.verifyAll(),
        currentKeyVersion: await keys.currentKeyVersion()
      }))
      return
    }
    if (!level1) {
      throw new Error('An active level-1 administrator is required for migration audit')
    }
    if (!preMutationBackup) {
      throw new Error('Credential migration backup was not created')
    }
    if (operation === 'migrate') {
      const summary = await migration.migratePlaintext(level1.id)
      console.log(JSON.stringify({
        operation,
        backup: preMutationBackup,
        summary
      }))
      return
    }
    const previousKeyVersion = await keys.currentKeyVersion()
    const currentKeyVersion = await keys.rotate()
    const summary = await migration.rewrapToCurrentKey(level1.id)
    console.log(JSON.stringify({
      operation,
      backup: preMutationBackup,
      previousKeyVersion,
      currentKeyVersion,
      summary
    }))
  } finally {
    await database.close()
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    operation: process.argv[2] || 'status',
    status: 'failed',
    error: error instanceof Error ? error.message : 'unknown error'
  }))
  process.exitCode = 1
})
