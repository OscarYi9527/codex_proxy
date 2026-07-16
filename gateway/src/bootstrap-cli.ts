import { pathToFileURL } from 'node:url'
import { SystemClock } from './common/clock.js'
import { CryptoIdSource } from './common/ids.js'
import { loadGatewayConfig } from './config.js'
import { createGatewayDatabase } from './db/database.js'
import { AuthRepository } from './db/repositories/auth-repository.js'
import { BootstrapService } from './auth/bootstrap-service.js'
import { PasswordService } from './auth/password-service.js'
import { loadGatewaySecrets } from './security/gateway-secrets.js'

export async function runGatewayBootstrap(): Promise<void> {
  const config = loadGatewayConfig()
  if (config.authMode === 'mock') return
  // Ensure signing/digest keys are created before the server starts. Their
  // values are never printed; production loads them from a secret manager.
  loadGatewaySecrets(config)
  const database = createGatewayDatabase(config)
  try {
    await database.migrateToLatest()
    const repository = new AuthRepository(
      database.db,
      callback => database.inTransaction(callback)
    )
    const result = await new BootstrapService(
      repository,
      new PasswordService(),
      new SystemClock(),
      new CryptoIdSource()
    ).initialize()
    if (result.created && result.loginName && result.temporaryPassword) {
      console.log('AI Editor Gateway initial administrator')
      console.log(`Login name: ${result.loginName}`)
      console.log(`One-time bootstrap password: ${result.temporaryPassword}`)
      console.log('This password will not be shown again. Change it immediately.')
    }
  } finally {
    await database.close()
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isMain) await runGatewayBootstrap()
