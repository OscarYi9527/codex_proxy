import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { databaseHandle } from '../../src/db/database.js'
import { createSqliteDatabase } from '../../src/db/dialects/sqlite.js'
import { ProviderRepository } from '../../src/db/repositories/provider-repository.js'
import { StaticCredentialKeyProvider } from '../../src/security/credential-keys.js'
import { EncryptedSqliteBackupService } from '../../src/security/encrypted-sqlite-backup.js'
import { EnvelopeCredentialProtector } from '../../src/security/envelope-credential-protector.js'

describe('encrypted SQLite credential backup recovery (T136)', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('backs up and restores without exposing Provider plaintext', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-encrypted-backup-'))
    directories.push(root)
    const source = path.join(root, 'gateway.sqlite')
    const backup = path.join(root, 'gateway.sqlite.gateway-backup')
    const restored = path.join(root, 'restored', 'gateway.sqlite')
    const database = databaseHandle(createSqliteDatabase(source))
    await database.migrateToLatest()
    const keys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-backup-v1',
      keys: {
        'kms-backup-v1': new Uint8Array(32).fill(47)
      }
    })
    const protector = new EnvelopeCredentialProtector(keys)
    const repository = new ProviderRepository(
      database.db,
      callback => database.inTransaction(callback),
      protector
    )
    const now = '2026-07-20T00:00:00.000Z'
    await repository.insertProvider({
      id: 'provider_backup',
      kind: 'openai',
      displayName: 'Backup Provider',
      status: 'active',
      config: {},
      createdAt: now,
      updatedAt: now,
      version: 1
    })
    await repository.insertCredential({
      id: 'credential_backup',
      providerId: 'provider_backup',
      storageKind: 'plaintext-v1',
      secretPayload: 'sk-backup-secret-never-visible',
      keyVersion: null,
      credentialVersion: 1,
      createdAt: now,
      updatedAt: now
    })

    const backups = new EncryptedSqliteBackupService(keys)
    const created = await backups.create(source, backup)
    expect(created.keyVersion).toBe('kms-backup-v1')
    const backupText = fs.readFileSync(backup, 'utf8')
    expect(backupText).not.toContain('sk-backup-secret-never-visible')
    expect(backupText).not.toContain('provider_backup')

    await backups.restore(backup, restored)
    const restoredDatabase = databaseHandle(createSqliteDatabase(restored))
    try {
      const restoredRepository = new ProviderRepository(
        restoredDatabase.db,
        callback => restoredDatabase.inTransaction(callback),
        protector
      )
      await expect(restoredRepository.listCredentials()).resolves.toEqual([
        expect.objectContaining({
          id: 'credential_backup',
          secretPayload: 'sk-backup-secret-never-visible',
          storageKind: 'envelope-v1'
        })
      ])
    } finally {
      await restoredDatabase.close()
      await database.close()
    }
  })

  it('rejects tampered backups and wrong master keys', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-backup-tamper-'))
    directories.push(root)
    const source = path.join(root, 'gateway.sqlite')
    const backup = path.join(root, 'gateway.gateway-backup')
    const database = databaseHandle(createSqliteDatabase(source))
    await database.migrateToLatest()
    await database.close()
    const keys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-backup-v1',
      keys: {
        'kms-backup-v1': new Uint8Array(32).fill(53)
      }
    })
    const backups = new EncryptedSqliteBackupService(keys)
    await backups.create(source, backup)

    const tampered = JSON.parse(fs.readFileSync(backup, 'utf8'))
    tampered.payload.tag = Buffer.alloc(16, 2).toString('base64')
    const tamperedFile = path.join(root, 'tampered.gateway-backup')
    fs.writeFileSync(tamperedFile, JSON.stringify(tampered))
    await expect(backups.restore(
      tamperedFile,
      path.join(root, 'tampered-restored.sqlite')
    )).rejects.toThrow(/authentication/)

    const wrongKeys = new StaticCredentialKeyProvider({
      currentVersion: 'kms-backup-v1',
      keys: {
        'kms-backup-v1': new Uint8Array(32).fill(59)
      }
    })
    await expect(new EncryptedSqliteBackupService(wrongKeys).restore(
      backup,
      path.join(root, 'wrong-key.sqlite')
    )).rejects.toThrow(/authentication/)
  })
})
