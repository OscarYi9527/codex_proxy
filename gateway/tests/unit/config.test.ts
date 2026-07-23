import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadGatewayConfig } from '../../src/config.js'

describe('Gateway fixed development configuration', () => {
  const repositoryRoot = path.resolve('F:/isolated-repository')
  const tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-postgres-tls-'))
  const postgresCaFile = path.join(tlsRoot, 'postgres-ca.pem')
  const postgresCertFile = path.join(tlsRoot, 'postgres-client.pem')
  const postgresKeyFile = path.join(tlsRoot, 'postgres-client-key.pem')

  beforeAll(() => {
    fs.writeFileSync(postgresCaFile, 'test postgres ca')
    fs.writeFileSync(postgresCertFile, 'test postgres client certificate')
    fs.writeFileSync(postgresKeyFile, 'test postgres client key')
  })

  afterAll(() => {
    fs.rmSync(tlsRoot, { recursive: true, force: true })
  })

  it('uses fixed loopback ports and isolated data roots by default', () => {
    const config = loadGatewayConfig({ NODE_ENV: 'test' }, { repositoryRoot })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(47920)
    expect(config.publicOrigin).toBe('http://127.0.0.1:47920')
    expect(config.dataRoot).toBe(path.join(repositoryRoot, '.ai-editor-dev', 'gateway'))
    expect(config.database.sqliteFile).toBe(path.join(config.dataRoot, 'gateway.sqlite'))
    expect(config.database.migrateOnStart).toBe(true)
    expect(config.authMode).toBe('real')
    expect(config.requestBody).toEqual({
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 60_000
    })
  })

  it('bounds configurable request body limits and upload timeouts', () => {
    const configured = loadGatewayConfig({
      NODE_ENV: 'test',
      CODEX_PROXY_MAX_BODY_MIB: '128',
      CODEX_PROXY_BODY_TIMEOUT_MS: '90000'
    }, { repositoryRoot })
    expect(configured.requestBody).toEqual({
      maxBytes: 128 * 1024 * 1024,
      timeoutMs: 90_000
    })

    const bounded = loadGatewayConfig({
      NODE_ENV: 'test',
      CODEX_PROXY_MAX_BODY_MIB: '999',
      CODEX_PROXY_BODY_TIMEOUT_MS: '999999'
    }, { repositoryRoot })
    expect(bounded.requestBody).toEqual({
      maxBytes: 256 * 1024 * 1024,
      timeoutMs: 300_000
    })
  })

  it('rejects shared port, public development host, and repository data root', () => {
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_PORT: '47892'
    }, { repositoryRoot })).toThrow(/47892|Invalid isolated/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_PORT: '47922'
    }, { repositoryRoot })).toThrow(/47920/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_HOST: '0.0.0.0'
    }, { repositoryRoot })).toThrow(/127\.0\.0\.1/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_DATA_ROOT: repositoryRoot
    }, { repositoryRoot })).toThrow(/not isolated/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_GATEWAY_DATA_ROOT: path.resolve('F:/shared-runtime')
    }, { repositoryRoot })).toThrow(/must be under/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'unsupported'
    }, { repositoryRoot })).toThrow(/Unsupported Gateway environment/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_MOCK_STATE: 'unknown'
    }, { repositoryRoot })).toThrow(/Unsupported mock account state/)
  })

  it('accepts only the fixed local Provider Worker contract in development', () => {
    const config = loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_PROVIDER_WORKER_ORIGIN: 'http://127.0.0.1:47930',
      AI_EDITOR_PROVIDER_WORKER_GATEWAY_ID: 'gateway-test',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET:
        'provider-worker-config-test-secret-32bytes-minimum'
    }, { repositoryRoot })
    expect(config.providerWorker).toEqual({
      origin: 'http://127.0.0.1:47930',
      gatewayId: 'gateway-test',
      workerId: 'worker-local',
      region: 'local-development',
      signingSecret: 'provider-worker-config-test-secret-32bytes-minimum',
      tls: null
    })
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_PROVIDER_WORKER_ORIGIN: 'http://127.0.0.1:47931',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET:
        'provider-worker-config-test-secret-32bytes-minimum'
    }, { repositoryRoot })).toThrow(/47930/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      AI_EDITOR_PROVIDER_WORKER_ORIGIN: 'http://127.0.0.1:47930',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET: 'short'
    }, { repositoryRoot })).toThrow(/at least 32 bytes/)
  })

  it('supports a loopback-only HTTPS preview behind an outbound tunnel', () => {
    const preview = loadGatewayConfig({
      NODE_ENV: 'preview',
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'https://preview.torvye.com',
      AI_EDITOR_PROVIDER_WORKER_ORIGIN: 'http://127.0.0.1:47930',
      AI_EDITOR_PROVIDER_WORKER_GATEWAY_ID: 'gateway-preview',
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET:
        'provider-worker-preview-secret-32bytes-minimum'
    }, { repositoryRoot })
    expect(preview).toMatchObject({
      environment: 'preview',
      host: '127.0.0.1',
      port: 47920,
      publicOrigin: 'https://preview.torvye.com',
      authMode: 'real',
      providerWorker: {
        origin: 'http://127.0.0.1:47930',
        gatewayId: 'gateway-preview',
        tls: null
      }
    })
    expect(() => loadGatewayConfig({
      NODE_ENV: 'preview',
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'http://preview.torvye.com'
    }, { repositoryRoot })).toThrow(/HTTPS origin/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'preview',
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'https://preview.torvye.com',
      AI_EDITOR_GATEWAY_HOST: '0.0.0.0'
    }, { repositoryRoot })).toThrow(/127\.0\.0\.1/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'preview',
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'https://preview.torvye.com',
      AI_EDITOR_GATEWAY_AUTH_MODE: 'mock'
    }, { repositoryRoot })).toThrow(/Mock authentication is forbidden/)
  })

  it('requires HTTPS and mTLS client credentials for a production Worker', () => {
    const dataRoot = path.resolve('F:/production-gateway-data')
    const base = {
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'https://gateway.example.test',
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@database.example.test/gateway',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile,
      AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET:
        'provider-worker-config-test-secret-32bytes-minimum'
    }
    expect(() => loadGatewayConfig({
      ...base,
      AI_EDITOR_PROVIDER_WORKER_ORIGIN: 'http://worker.example.test'
    }, { repositoryRoot })).toThrow(/HTTPS origin/)
    expect(() => loadGatewayConfig({
      ...base,
      AI_EDITOR_PROVIDER_WORKER_ORIGIN: 'https://worker.example.test'
    }, { repositoryRoot })).toThrow(/mTLS client credentials/)
  })

  it('supports explicit production PostgreSQL configuration', () => {
    const dataRoot = path.resolve('F:/production-gateway-data')
    const production = loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_HOST: '10.0.0.5',
      AI_EDITOR_GATEWAY_PORT: '8443',
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'https://gateway.example.test',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile,
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CERT: postgresCertFile,
      AI_EDITOR_GATEWAY_POSTGRES_TLS_KEY: postgresKeyFile,
      AI_EDITOR_GATEWAY_POSTGRES_TLS_SERVER_NAME: 'database.example.test',
      AI_EDITOR_MOCK_STATE: 'login_required'
    }, { repositoryRoot })
    expect(production).toMatchObject({
      environment: 'production',
      host: '10.0.0.5',
      port: 8443,
      publicOrigin: 'https://gateway.example.test',
      dataRoot,
      authMode: 'real',
      mockState: 'login_required',
      database: {
        dialect: 'postgres',
        postgresUrl: 'postgres://gateway@example.test/gateway',
        postgresTls: {
          caFile: postgresCaFile,
          certFile: postgresCertFile,
          keyFile: postgresKeyFile,
          serverName: 'database.example.test'
        },
        migrateOnStart: false
      }
    })
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres'
    }, { repositoryRoot })).toThrow(/POSTGRES_URL/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway'
    }, { repositoryRoot })).toThrow(/trusted CA/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway?ssl=true',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile
    }, { repositoryRoot })).toThrow(/connection-string SSL parameters/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile,
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CERT: postgresCertFile
    }, { repositoryRoot })).toThrow(/certificate and key/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot
    }, { repositoryRoot })).toThrow(/requires PostgreSQL/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile,
      AI_EDITOR_GATEWAY_AUTH_MODE: 'mock'
    }, { repositoryRoot })).toThrow(/Mock authentication is forbidden/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile,
      AI_EDITOR_GATEWAY_MIGRATE_ON_START: 'true'
    }, { repositoryRoot })).toThrow(/cannot auto-migrate/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      AI_EDITOR_GATEWAY_DATA_ROOT: dataRoot,
      AI_EDITOR_GATEWAY_DB_DIALECT: 'postgres',
      AI_EDITOR_GATEWAY_POSTGRES_URL: 'postgres://gateway@example.test/gateway',
      AI_EDITOR_GATEWAY_POSTGRES_TLS_CA: postgresCaFile,
      AI_EDITOR_GATEWAY_PUBLIC_ORIGIN: 'http://gateway.example.test'
    }, { repositoryRoot })).toThrow(/HTTPS origin/)
  })

  it('fails closed when Node TLS certificate verification is disabled', () => {
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    }, { repositoryRoot })).toThrow(/TLS certificate verification is disabled/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'development',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    }, { repositoryRoot })).toThrow(/NODE_EXTRA_CA_CERTS/)
    expect(() => loadGatewayConfig({
      NODE_ENV: 'test',
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
      NODE_EXTRA_CA_CERTS: path.join(repositoryRoot, 'development-ca.pem')
    }, { repositoryRoot })).not.toThrow()
  })
})
