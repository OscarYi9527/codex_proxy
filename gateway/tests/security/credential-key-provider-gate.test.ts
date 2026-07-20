import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GatewayConfig } from '../../src/config.js'
import {
  DevelopmentFileCredentialKeyProvider,
  loadCredentialKeyProvider
} from '../../src/security/credential-keys.js'

describe('credential master-key provider gate (T136)', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists development keys outside the database and restores them after restart', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-key-provider-'))
    directories.push(dataRoot)
    const first = new DevelopmentFileCredentialKeyProvider(dataRoot)
    const firstVersion = await first.currentKeyVersion()
    const second = new DevelopmentFileCredentialKeyProvider(dataRoot)
    expect(await second.currentKeyVersion()).toBe(firstVersion)
    expect(fs.existsSync(path.join(
      dataRoot,
      'gateway-credential-master-keys.gateway-secret'
    ))).toBe(true)
  })

  it('refuses to substitute a local key file for production KMS', () => {
    const config = {
      environment: 'production',
      dataRoot: '/production/gateway'
    } as GatewayConfig
    expect(() => loadCredentialKeyProvider(config)).toThrow(
      /injected KMS\/Secret Manager/
    )
  })
})
