import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type {
  CredentialKeyProvider,
  WrappedDataKey
} from './credential-keys.js'

const BACKUP_VERSION = 1
const DATA_KEY_BYTES = 32
const NONCE_BYTES = 12

interface EncryptedSqliteBackupV1 {
  readonly version: 1
  readonly algorithm: 'A256GCM'
  readonly backupId: string
  readonly createdAt: string
  readonly sourceKind: 'gateway-sqlite'
  readonly keyVersion: string
  readonly wrappedDataKey: WrappedDataKey
  readonly payload: {
    readonly nonce: string
    readonly ciphertext: string
    readonly tag: string
  }
}

function aad(
  backup: Pick<EncryptedSqliteBackupV1, 'backupId' | 'createdAt' | 'sourceKind'>,
  purpose: 'payload' | 'dek'
): Buffer {
  return Buffer.from([
    'aieditor-gateway-backup-v1',
    backup.backupId,
    backup.createdAt,
    backup.sourceKind,
    purpose
  ].join('\n'), 'utf8')
}

function decode(value: string, length: number | null, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  const result = Buffer.from(value, 'base64')
  if (
    (length !== null && result.length !== length) ||
    result.toString('base64') !== value
  ) {
    result.fill(0)
    throw new Error(`${name} is invalid`)
  }
  return result
}

function parse(value: unknown): EncryptedSqliteBackupV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Encrypted Gateway backup is invalid')
  }
  const backup = value as Partial<EncryptedSqliteBackupV1>
  if (
    backup.version !== BACKUP_VERSION ||
    backup.algorithm !== 'A256GCM' ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(String(backup.backupId || '')) ||
    typeof backup.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(backup.createdAt)) ||
    backup.sourceKind !== 'gateway-sqlite' ||
    typeof backup.keyVersion !== 'string' ||
    !backup.wrappedDataKey ||
    backup.wrappedDataKey.keyVersion !== backup.keyVersion ||
    !backup.payload ||
    typeof backup.payload.nonce !== 'string' ||
    typeof backup.payload.ciphertext !== 'string' ||
    typeof backup.payload.tag !== 'string'
  ) {
    throw new Error('Encrypted Gateway backup metadata is invalid')
  }
  return backup as EncryptedSqliteBackupV1
}

function atomicWrite(file: string, payload: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Windows ACLs are inherited from the destination directory.
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
  }
}

export class EncryptedSqliteBackupService {
  constructor(private readonly keys: CredentialKeyProvider) {}

  async create(sourceFile: string, destinationFile: string): Promise<{
    readonly backupId: string
    readonly keyVersion: string
    readonly destinationFile: string
  }> {
    if (!fs.existsSync(sourceFile)) throw new Error('Gateway SQLite database does not exist')
    if (fs.existsSync(destinationFile)) {
      throw new Error('Encrypted Gateway backup destination already exists')
    }
    const resolvedDestination = path.resolve(destinationFile)
    const snapshot = `${resolvedDestination}.${process.pid}.sqlite.tmp`
    const database = new BetterSqlite3(sourceFile, { readonly: true })
    try {
      await database.backup(snapshot)
    } catch (error) {
      if (fs.existsSync(snapshot)) fs.rmSync(snapshot, { force: true })
      throw error
    } finally {
      database.close()
    }
    let plaintext: Buffer
    try {
      plaintext = fs.readFileSync(snapshot)
    } catch (error) {
      if (fs.existsSync(snapshot)) fs.rmSync(snapshot, { force: true })
      throw error
    }
    try {
      fs.rmSync(snapshot, { force: true })
    } catch (error) {
      plaintext.fill(0)
      throw error
    }
    const dataKey = crypto.randomBytes(DATA_KEY_BYTES)
    const nonce = crypto.randomBytes(NONCE_BYTES)
    const header = {
      backupId: `backup_${crypto.randomBytes(18).toString('base64url')}`,
      createdAt: new Date().toISOString(),
      sourceKind: 'gateway-sqlite' as const
    }
    const payloadAad = aad(header, 'payload')
    const dataKeyAad = aad(header, 'dek')
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, nonce)
      cipher.setAAD(payloadAad)
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
      ])
      const tag = cipher.getAuthTag()
      const wrappedDataKey = await this.keys.wrapDataKey(dataKey, dataKeyAad)
      const backup: EncryptedSqliteBackupV1 = {
        version: BACKUP_VERSION,
        algorithm: 'A256GCM',
        ...header,
        keyVersion: wrappedDataKey.keyVersion,
        wrappedDataKey,
        payload: {
          nonce: nonce.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          tag: tag.toString('base64')
        }
      }
      try {
        atomicWrite(resolvedDestination, `${JSON.stringify(backup)}\n`)
      } finally {
        ciphertext.fill(0)
        tag.fill(0)
      }
      return {
        backupId: backup.backupId,
        keyVersion: backup.keyVersion,
        destinationFile: resolvedDestination
      }
    } finally {
      plaintext.fill(0)
      dataKey.fill(0)
      nonce.fill(0)
      payloadAad.fill(0)
      dataKeyAad.fill(0)
      if (fs.existsSync(snapshot)) fs.rmSync(snapshot, { force: true })
    }
  }

  async restore(sourceFile: string, destinationFile: string): Promise<void> {
    if (fs.existsSync(destinationFile)) {
      throw new Error('Gateway restore destination already exists')
    }
    const backup = parse(JSON.parse(fs.readFileSync(sourceFile, 'utf8')))
    const payloadAad = aad(backup, 'payload')
    const dataKeyAad = aad(backup, 'dek')
    const dataKey = Buffer.from(await this.keys.unwrapDataKey(
      backup.wrappedDataKey,
      dataKeyAad
    ))
    const nonce = decode(backup.payload.nonce, NONCE_BYTES, 'Backup nonce')
    const ciphertext = decode(
      backup.payload.ciphertext,
      null,
      'Backup ciphertext'
    )
    const tag = decode(backup.payload.tag, 16, 'Backup authentication tag')
    let plaintext = Buffer.alloc(0)
    const resolvedDestination = path.resolve(destinationFile)
    const temporary = `${resolvedDestination}.${process.pid}.restore.tmp`
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, nonce)
      decipher.setAAD(payloadAad)
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ])
      atomicWrite(temporary, plaintext)
      const database = new BetterSqlite3(temporary, { readonly: true })
      try {
        const result = database.pragma('integrity_check', { simple: true })
        if (result !== 'ok') throw new Error('Restored Gateway database failed integrity check')
      } finally {
        database.close()
      }
      fs.mkdirSync(path.dirname(resolvedDestination), {
        recursive: true,
        mode: 0o700
      })
      fs.renameSync(temporary, resolvedDestination)
    } catch (error) {
      throw new Error('Encrypted Gateway backup authentication failed', {
        cause: error
      })
    } finally {
      dataKey.fill(0)
      nonce.fill(0)
      ciphertext.fill(0)
      tag.fill(0)
      plaintext.fill(0)
      payloadAad.fill(0)
      dataKeyAad.fill(0)
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
    }
  }
}
