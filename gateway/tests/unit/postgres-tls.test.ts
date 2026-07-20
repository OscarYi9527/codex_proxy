import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shouldMigrateGatewayDatabase } from '../../src/app.js'
import type { GatewayConfig } from '../../src/config.js'
import { buildPostgresPoolConfig } from '../../src/db/dialects/postgres.js'

describe('production PostgreSQL TLS pool configuration', () => {
  const tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-postgres-pool-'))
  const caFile = path.join(tlsRoot, 'ca.pem')
  const certFile = path.join(tlsRoot, 'client.pem')
  const keyFile = path.join(tlsRoot, 'client-key.pem')

  beforeAll(() => {
    fs.writeFileSync(caFile, 'postgres ca')
    fs.writeFileSync(certFile, 'postgres client certificate')
    fs.writeFileSync(keyFile, 'postgres client key')
  })

  afterAll(() => {
    fs.rmSync(tlsRoot, { recursive: true, force: true })
  })

  it('loads the trusted CA and optional client identity with verification enabled', () => {
    const config = buildPostgresPoolConfig({
      connectionString: 'postgres://gateway@database.example.test/gateway',
      tls: {
        caFile,
        certFile,
        keyFile,
        serverName: 'database.example.test'
      }
    })
    expect(config.connectionString).toBe(
      'postgres://gateway@database.example.test/gateway'
    )
    expect(config.ssl).toEqual({
      ca: 'postgres ca',
      cert: 'postgres client certificate',
      key: 'postgres client key',
      rejectUnauthorized: true,
      servername: 'database.example.test'
    })
  })

  it('supports CA-only managed PostgreSQL without disabling verification', () => {
    const config = buildPostgresPoolConfig({
      connectionString: 'postgres://gateway@database.example.test/gateway',
      tls: { caFile }
    })
    expect(config.ssl).toEqual({
      ca: 'postgres ca',
      rejectUnauthorized: true
    })
  })

  it('rejects a partial client TLS identity defensively', () => {
    expect(() => buildPostgresPoolConfig({
      connectionString: 'postgres://gateway@database.example.test/gateway',
      tls: { caFile, certFile }
    })).toThrow(/certificate and key/)
  })

  it('never auto-migrates with the production runtime database identity', () => {
    const production = {
      environment: 'production',
      database: { migrateOnStart: true }
    } as GatewayConfig
    const development = {
      environment: 'development',
      database: { migrateOnStart: true }
    } as GatewayConfig
    expect(shouldMigrateGatewayDatabase(production)).toBe(false)
    expect(shouldMigrateGatewayDatabase(development)).toBe(true)
  })
})
