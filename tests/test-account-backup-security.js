import './helpers/test-storage-root.js'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  atomicWriteJson,
  CONFIG_FILE,
  createAccountBackup,
  initializeCredentialProtection,
  reloadProxyConfig,
  restoreAccountBackup,
  restoreConfigSnapshot,
  saveProxyConfig,
  STORAGE_ROOT
} from '../src/config.js'
import {
  decryptConfigSecrets,
  isEncryptedSecret
} from '../src/credential-store.js'
import { scanValueSecrets } from '../src/secret-scan.js'

describe('account backup secret protection', () => {
  it('refuses plaintext backups and round-trips a DPAPI-protected backup on Windows', {
    timeout: 30_000
  }, () => {
    const token = `refresh_${'x'.repeat(40)}`
    const account = {
      id: 'backup-account',
      account_id: 'backup-account-upstream',
      label: 'Backup fixture',
      refresh_token: token
    }
    atomicWriteJson(CONFIG_FILE, {
      schema_version: 3,
      chatgpt_accounts: [account],
      active_chatgpt_account_id: account.id
    })

    assert.throws(
      () => createAccountBackup('plaintext-refused'),
      /Account backup requires encrypted credentials/
    )
    const backupDirectory = path.join(STORAGE_ROOT, '.account-backups')
    assert.deepEqual(
      fs.existsSync(backupDirectory) ? fs.readdirSync(backupDirectory) : [],
      []
    )
    const settingsDirectory = path.join(STORAGE_ROOT, '.config-backups')
    const unsafeSettingsFile = path.join(settingsDirectory, 'unsafe-settings.json')
    atomicWriteJson(unsafeSettingsFile, {
      custom_secret: token,
      _snapshot: { version: 2, scope: 'settings-only' }
    })
    assert.throws(
      () => restoreConfigSnapshot(path.basename(unsafeSettingsFile)),
      /Settings backup contains a secret/
    )

    if (process.platform !== 'win32') return

    const migrationDirectory = path.join(STORAGE_ROOT, '.migration-backups')
    const legacyMigrationFile = path.join(migrationDirectory, 'legacy-config.bak')
    atomicWriteJson(legacyMigrationFile, {
      chatgpt_accounts: [account]
    })
    const protection = initializeCredentialProtection()
    assert.equal(protection.enabled, true)
    const protectedMigration = JSON.parse(
      fs.readFileSync(legacyMigrationFile, 'utf8')
    )
    assert.ok(!fs.readFileSync(legacyMigrationFile, 'utf8').includes(token))
    assert.equal(
      isEncryptedSecret(protectedMigration.chatgpt_accounts[0].refresh_token),
      true
    )
    assert.equal(
      decryptConfigSecrets(protectedMigration)
        .chatgpt_accounts[0].refresh_token,
      token
    )

    const backupFile = createAccountBackup('encrypted-roundtrip')
    assert.ok(backupFile)
    const raw = fs.readFileSync(backupFile, 'utf8')
    assert.ok(!raw.includes(token))

    const stored = JSON.parse(raw)
    assert.equal(
      isEncryptedSecret(stored.chatgpt_accounts[0].refresh_token),
      true
    )
    assert.deepEqual(scanValueSecrets(stored, {
      source: 'account-backup-test',
      allowProtectedValues: true
    }), [])
    assert.equal(
      decryptConfigSecrets(stored).chatgpt_accounts[0].refresh_token,
      token
    )

    saveProxyConfig({
      chatgptAccounts: [],
      activeChatgptAccountId: null
    })
    reloadProxyConfig()
    const restored = restoreAccountBackup(path.basename(backupFile))
    assert.equal(restored.restoredCount, 1)
    assert.equal(
      restored.config.chatgptAccounts[0].refresh_token,
      token
    )
  })
})
