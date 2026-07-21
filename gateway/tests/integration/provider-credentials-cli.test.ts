import type { GatewayConfig } from '../../src/config.js'
import { databaseHandle, type DatabaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import {
  providerCredentialCliErrorMessage,
  runProviderCredentialCommand
} from '../../src/provider-credentials-cli.js'
import {
  StaticProviderCredentialKeyring
} from '../../src/security/provider-master-key.js'

const config: GatewayConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 47920,
  publicOrigin: 'http://127.0.0.1:47920',
  dataRoot: '.ai-editor-dev/provider-credential-cli-test',
  database: { dialect: 'sqlite', sqliteFile: ':memory:' },
  authMode: 'real',
  mockState: 'ready'
}

describe('Provider credential maintenance CLI', () => {
  let database: DatabaseHandle

  beforeEach(async () => {
    database = databaseHandle(createSqliteDatabase(':memory:'))
    await database.migrateToLatest()
    await database.db.insertInto('providers').values({
      id: 'provider_cli',
      kind: 'openai',
      display_name: 'CLI Provider',
      status: 'disabled',
      config_json: '{}',
      created_at: '2026-07-21T00:00:00.000Z',
      updated_at: '2026-07-21T00:00:00.000Z',
      version: 1
    }).execute()
    await database.db.insertInto('provider_credentials').values({
      id: 'credential_cli',
      provider_id: 'provider_cli',
      storage_kind: 'plaintext-v1',
      secret_payload: 'cli-migration-secret-value',
      created_at: '2026-07-21T00:00:00.000Z',
      updated_at: '2026-07-21T00:00:00.000Z'
    }).execute()
  })

  afterEach(async () => {
    await database.close()
  })

  it('prints only safe counts and key IDs for dry-run and migration', async () => {
    const keyring = new StaticProviderCredentialKeyring(
      'provider-cli-key',
      new Map([['provider-cli-key', new Uint8Array(32).fill(4)]])
    )
    const output: string[] = []
    const dependencies = {
      config,
      database,
      keyring,
      output: (value: string) => output.push(value)
    }

    await runProviderCredentialCommand(['--migrate', '--dry-run'], dependencies)
    expect(output.join('')).not.toContain('cli-migration-secret-value')
    expect(output.join('')).toContain('"changedCredentials": 1')
    expect((await database.db
      .selectFrom('provider_credentials')
      .select('storage_kind')
      .executeTakeFirstOrThrow()).storage_kind).toBe('plaintext-v1')

    output.length = 0
    await runProviderCredentialCommand(['--migrate'], dependencies)
    const stored = await database.db
      .selectFrom('provider_credentials')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(stored.storage_kind).toBe('envelope-v1')
    expect(stored.secret_payload).not.toContain('cli-migration-secret-value')
    expect(output.join('')).not.toContain('cli-migration-secret-value')

    output.length = 0
    await runProviderCredentialCommand(['--verify'], dependencies)
    expect(output.join('')).toContain('"verifiedCredentials": 1')
    expect(output.join('')).not.toContain('cli-migration-secret-value')
  })

  it('does not accept credentials or keys as command-line arguments', async () => {
    await expect(runProviderCredentialCommand([
      '--migrate',
      '--secret=must-not-be-accepted'
    ], { config, database })).rejects.toThrow(/^Usage:/)
    expect(providerCredentialCliErrorMessage(
      new Error('database failed near cli-migration-secret-value')
    )).toBe(
      'Provider credential operation failed; sensitive details were suppressed'
    )
  })
})
