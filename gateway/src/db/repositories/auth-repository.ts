import type { Kysely, Transaction } from 'kysely'
import type { GatewayDatabase } from '../schema.js'
import type {
  AccountRole,
  DeviceDescriptor,
  ProductAccount
} from '../../auth/types.js'

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>

export interface PasswordCredentialRecord {
  readonly accountId: string
  readonly passwordHash: string
  readonly kind: 'permanent' | 'bootstrap' | 'temporary'
  readonly createdAt: string
  readonly usedAt: string | null
  readonly expiresAt: string | null
  readonly passwordVersion: number
}

export interface AuthorizationCodeRecord {
  readonly codeDigest: string
  readonly accountId: string
  readonly pkceChallenge: string
  readonly redirectUri: string
  readonly stateBinding: string
  readonly expiresAt: string
  readonly consumedAt: string | null
}

export interface RefreshTokenContext {
  readonly tokenId: string
  readonly tokenDigest: string
  readonly familyId: string
  readonly parentTokenId: string | null
  readonly tokenExpiresAt: string
  readonly consumedAt: string | null
  readonly tokenRevokedAt: string | null
  readonly sessionId: string
  readonly sessionExpiresAt: string
  readonly sessionRevokedAt: string | null
  readonly sessionPasswordVersion: number
  readonly account: ProductAccount
  readonly credentialPasswordVersion: number
}

export interface AccessSessionContext {
  readonly sessionId: string
  readonly sessionExpiresAt: string
  readonly sessionRevokedAt: string | null
  readonly sessionPasswordVersion: number
  readonly account: ProductAccount
  readonly credentialPasswordVersion: number
}

export interface NewAccountInput {
  readonly id: string
  readonly loginName: string | null
  readonly email: string | null
  readonly role: AccountRole
  readonly organizationId: string | null
  readonly mustChangePassword: boolean
  readonly mustProvideEmail: boolean
  readonly passwordHash: string
  readonly credentialKind: 'permanent' | 'bootstrap' | 'temporary'
  readonly accountExpiresAt: string | null
  readonly passwordExpiresAt: string | null
  readonly now: string
}

export interface NewRefreshTokenInput {
  readonly id: string
  readonly sessionId: string
  readonly familyId: string
  readonly digest: string
  readonly parentTokenId: string | null
  readonly issuedAt: string
  readonly expiresAt: string
}

function toProductAccount(row: {
  id: string
  login_name: string | null
  email: string | null
  role: AccountRole
  organization_id: string | null
  organization_name: string | null
  organization_status: 'active' | 'disabled' | null
  status: 'active' | 'disabled' | 'expired'
  expires_at: string | null
  must_change_password: number
  must_provide_email: number
  version: number
}): ProductAccount {
  return {
    id: row.id,
    loginName: row.login_name,
    email: row.email,
    role: row.role,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationStatus: row.organization_status,
    status: row.status,
    expiresAt: row.expires_at,
    mustChangePassword: row.must_change_password !== 0,
    mustProvideEmail: row.must_provide_email !== 0,
    version: row.version
  }
}

function accountSelection(db: DatabaseExecutor) {
  return db
    .selectFrom('accounts as account')
    .leftJoin('organizations as organization', 'organization.id', 'account.organization_id')
    .select([
      'account.id',
      'account.login_name',
      'account.email',
      'account.role',
      'account.organization_id',
      'organization.name as organization_name',
      'organization.status as organization_status',
      'account.status',
      'account.expires_at',
      'account.must_change_password',
      'account.must_provide_email',
      'account.version'
    ])
}

export class AuthRepository {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly transactionRunner?: <T>(
      callback: (transaction: Transaction<GatewayDatabase>) => Promise<T>
    ) => Promise<T>
  ) {}

  async inTransaction<T>(callback: (repository: AuthRepository) => Promise<T>): Promise<T> {
    if (!this.transactionRunner) {
      throw new Error('AuthRepository transaction boundary is unavailable')
    }
    return this.transactionRunner(transaction =>
      callback(new AuthRepository(transaction))
    )
  }

  async countAccounts(): Promise<number> {
    const row = await this.db
      .selectFrom('accounts')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async insertAccountAndCredential(input: NewAccountInput): Promise<void> {
    await this.db.insertInto('accounts').values({
      id: input.id,
      login_name: input.loginName,
      email: input.email,
      role: input.role,
      organization_id: input.organizationId,
      status: 'active',
      expires_at: input.accountExpiresAt,
      must_change_password: input.mustChangePassword ? 1 : 0,
      must_provide_email: input.mustProvideEmail ? 1 : 0,
      created_at: input.now,
      updated_at: input.now,
      disabled_at: null,
      disabled_by: null,
      version: 1
    }).execute()
    await this.db.insertInto('password_credentials').values({
      account_id: input.id,
      password_hash: input.passwordHash,
      kind: input.credentialKind,
      created_at: input.now,
      used_at: null,
      expires_at: input.passwordExpiresAt,
      password_version: 1
    }).execute()
  }

  async findAccountByIdentifier(identifier: string): Promise<ProductAccount | null> {
    const normalized = identifier.trim().toLowerCase()
    const row = await accountSelection(this.db)
      .where(expression => expression.or([
        expression('account.login_name', '=', normalized),
        expression('account.email', '=', normalized)
      ]))
      .executeTakeFirst()
    return row ? toProductAccount(row) : null
  }

  async findAccountById(accountId: string): Promise<ProductAccount | null> {
    const row = await accountSelection(this.db)
      .where('account.id', '=', accountId)
      .executeTakeFirst()
    return row ? toProductAccount(row) : null
  }

  async getPasswordCredential(accountId: string): Promise<PasswordCredentialRecord | null> {
    const row = await this.db
      .selectFrom('password_credentials')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst()
    return row ? {
      accountId: row.account_id,
      passwordHash: row.password_hash,
      kind: row.kind,
      createdAt: row.created_at,
      usedAt: row.used_at,
      expiresAt: row.expires_at,
      passwordVersion: row.password_version
    } : null
  }

  async markOneTimeCredentialUsed(accountId: string, now: string): Promise<boolean> {
    const result = await this.db
      .updateTable('password_credentials')
      .set({ used_at: now })
      .where('account_id', '=', accountId)
      .where('kind', 'in', ['bootstrap', 'temporary'])
      .where('used_at', 'is', null)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async replacePassword(options: {
    accountId: string
    passwordHash: string
    email: string | null
    now: string
  }): Promise<number> {
    const credential = await this.getPasswordCredential(options.accountId)
    if (!credential) throw new Error('Password credential is missing')
    const nextVersion = credential.passwordVersion + 1
    await this.db
      .updateTable('password_credentials')
      .set({
        password_hash: options.passwordHash,
        kind: 'permanent',
        created_at: options.now,
        used_at: null,
        expires_at: null,
        password_version: nextVersion
      })
      .where('account_id', '=', options.accountId)
      .execute()
    await this.db
      .updateTable('accounts')
      .set(expression => ({
        ...(options.email ? { email: options.email } : {}),
        must_change_password: 0,
        must_provide_email: options.email ? 0 : expression.ref('must_provide_email'),
        updated_at: options.now,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', options.accountId)
      .execute()
    return nextVersion
  }

  async replacePasswordWithTemporaryCredential(options: {
    accountId: string
    passwordHash: string
    expiresAt: string
    now: string
  }): Promise<number> {
    const credential = await this.getPasswordCredential(options.accountId)
    if (!credential) throw new Error('Password credential is missing')
    const nextVersion = credential.passwordVersion + 1
    await this.db
      .updateTable('password_credentials')
      .set({
        password_hash: options.passwordHash,
        kind: 'temporary',
        created_at: options.now,
        used_at: null,
        expires_at: options.expiresAt,
        password_version: nextVersion
      })
      .where('account_id', '=', options.accountId)
      .execute()
    await this.db
      .updateTable('accounts')
      .set(expression => ({
        must_change_password: 1,
        updated_at: options.now,
        version: expression('version', '+', 1)
      }))
      .where('id', '=', options.accountId)
      .execute()
    return nextVersion
  }

  async insertAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    await this.db.insertInto('authorization_codes').values({
      code_digest: record.codeDigest,
      account_id: record.accountId,
      pkce_challenge: record.pkceChallenge,
      redirect_uri: record.redirectUri,
      state_binding: record.stateBinding,
      expires_at: record.expiresAt,
      consumed_at: record.consumedAt
    }).execute()
  }

  async getAuthorizationCode(codeDigest: string): Promise<AuthorizationCodeRecord | null> {
    const row = await this.db
      .selectFrom('authorization_codes')
      .selectAll()
      .where('code_digest', '=', codeDigest)
      .executeTakeFirst()
    return row ? {
      codeDigest: row.code_digest,
      accountId: row.account_id,
      pkceChallenge: row.pkce_challenge,
      redirectUri: row.redirect_uri,
      stateBinding: row.state_binding,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at
    } : null
  }

  async consumeAuthorizationCode(codeDigest: string, now: string): Promise<boolean> {
    const result = await this.db
      .updateTable('authorization_codes')
      .set({ consumed_at: now })
      .where('code_digest', '=', codeDigest)
      .where('consumed_at', 'is', null)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async createDeviceSession(options: {
    id: string
    accountId: string
    device: DeviceDescriptor
    passwordVersion: number
    now: string
    expiresAt: string
  }): Promise<void> {
    await this.db.insertInto('device_sessions').values({
      id: options.id,
      account_id: options.accountId,
      device_name: options.device.name,
      platform: options.device.platform,
      created_at: options.now,
      last_used_at: options.now,
      expires_at: options.expiresAt,
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
      password_version: options.passwordVersion
    }).execute()
  }

  async revokeActiveSessionsForDevice(
    accountId: string,
    device: DeviceDescriptor,
    now: string
  ): Promise<void> {
    const sessions = await this.db
      .selectFrom('device_sessions')
      .select('id')
      .where('account_id', '=', accountId)
      .where('device_name', '=', device.name)
      .where('platform', '=', device.platform)
      .where('revoked_at', 'is', null)
      .execute()
    for (const session of sessions) {
      await this.revokeDeviceSession(session.id, now, 'superseded_same_device_login')
    }
  }

  async insertRefreshToken(input: NewRefreshTokenInput): Promise<void> {
    await this.db.insertInto('refresh_tokens').values({
      id: input.id,
      session_id: input.sessionId,
      family_id: input.familyId,
      token_digest: input.digest,
      parent_token_id: input.parentTokenId,
      issued_at: input.issuedAt,
      expires_at: input.expiresAt,
      consumed_at: null,
      revoked_at: null
    }).execute()
  }

  async getRefreshContext(tokenDigest: string): Promise<RefreshTokenContext | null> {
    const row = await this.db
      .selectFrom('refresh_tokens as token')
      .innerJoin('device_sessions as session', 'session.id', 'token.session_id')
      .innerJoin('accounts as account', 'account.id', 'session.account_id')
      .innerJoin('password_credentials as credential', 'credential.account_id', 'account.id')
      .leftJoin('organizations as organization', 'organization.id', 'account.organization_id')
      .select([
        'token.id as token_id',
        'token.token_digest',
        'token.family_id',
        'token.parent_token_id',
        'token.expires_at as token_expires_at',
        'token.consumed_at',
        'token.revoked_at as token_revoked_at',
        'session.id as session_id',
        'session.expires_at as session_expires_at',
        'session.revoked_at as session_revoked_at',
        'session.password_version as session_password_version',
        'credential.password_version as credential_password_version',
        'account.id',
        'account.login_name',
        'account.email',
        'account.role',
        'account.organization_id',
        'organization.name as organization_name',
        'organization.status as organization_status',
        'account.status',
        'account.expires_at',
        'account.must_change_password',
        'account.must_provide_email',
        'account.version'
      ])
      .where('token.token_digest', '=', tokenDigest)
      .executeTakeFirst()
    return row ? {
      tokenId: row.token_id,
      tokenDigest: row.token_digest,
      familyId: row.family_id,
      parentTokenId: row.parent_token_id,
      tokenExpiresAt: row.token_expires_at,
      consumedAt: row.consumed_at,
      tokenRevokedAt: row.token_revoked_at,
      sessionId: row.session_id,
      sessionExpiresAt: row.session_expires_at,
      sessionRevokedAt: row.session_revoked_at,
      sessionPasswordVersion: row.session_password_version,
      credentialPasswordVersion: row.credential_password_version,
      account: toProductAccount(row)
    } : null
  }

  async getAccessSessionContext(sessionId: string): Promise<AccessSessionContext | null> {
    const row = await this.db
      .selectFrom('device_sessions as session')
      .innerJoin('accounts as account', 'account.id', 'session.account_id')
      .innerJoin('password_credentials as credential', 'credential.account_id', 'account.id')
      .leftJoin('organizations as organization', 'organization.id', 'account.organization_id')
      .select([
        'session.id as session_id',
        'session.expires_at as session_expires_at',
        'session.revoked_at as session_revoked_at',
        'session.password_version as session_password_version',
        'credential.password_version as credential_password_version',
        'account.id',
        'account.login_name',
        'account.email',
        'account.role',
        'account.organization_id',
        'organization.name as organization_name',
        'organization.status as organization_status',
        'account.status',
        'account.expires_at',
        'account.must_change_password',
        'account.must_provide_email',
        'account.version'
      ])
      .where('session.id', '=', sessionId)
      .executeTakeFirst()
    return row ? {
      sessionId: row.session_id,
      sessionExpiresAt: row.session_expires_at,
      sessionRevokedAt: row.session_revoked_at,
      sessionPasswordVersion: row.session_password_version,
      credentialPasswordVersion: row.credential_password_version,
      account: toProductAccount(row)
    } : null
  }

  async consumeRefreshToken(tokenId: string, now: string): Promise<boolean> {
    const result = await this.db
      .updateTable('refresh_tokens')
      .set({ consumed_at: now })
      .where('id', '=', tokenId)
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async touchDeviceSession(sessionId: string, now: string, expiresAt: string): Promise<void> {
    await this.db
      .updateTable('device_sessions')
      .set({ last_used_at: now, expires_at: expiresAt })
      .where('id', '=', sessionId)
      .execute()
  }

  async resetCurrentSessionAfterPasswordChange(options: {
    sessionId: string
    passwordVersion: number
    now: string
    expiresAt: string
  }): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: options.now })
      .where('session_id', '=', options.sessionId)
      .where('revoked_at', 'is', null)
      .execute()
    await this.db
      .updateTable('device_sessions')
      .set({
        password_version: options.passwordVersion,
        last_used_at: options.now,
        expires_at: options.expiresAt,
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null
      })
      .where('id', '=', options.sessionId)
      .execute()
  }

  async revokeTokenFamily(
    familyId: string,
    sessionId: string,
    now: string,
    reason: string
  ): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: now })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute()
    await this.revokeDeviceSession(sessionId, now, reason)
  }

  async revokeDeviceSession(sessionId: string, now: string, reason: string): Promise<void> {
    await this.db
      .updateTable('device_sessions')
      .set({ revoked_at: now, revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute()
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: now })
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute()
  }

  async revokeOwnedDeviceSession(
    accountId: string,
    sessionId: string,
    now: string,
    reason: string
  ): Promise<boolean> {
    const owned = await this.db
      .selectFrom('device_sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('account_id', '=', accountId)
      .executeTakeFirst()
    if (!owned) return false
    await this.revokeDeviceSession(sessionId, now, reason)
    return true
  }

  async revokeOtherDeviceSessions(accountId: string, currentSessionId: string, now: string): Promise<void> {
    const sessions = await this.db
      .selectFrom('device_sessions')
      .select('id')
      .where('account_id', '=', accountId)
      .where('id', '!=', currentSessionId)
      .where('revoked_at', 'is', null)
      .execute()
    for (const session of sessions) {
      await this.revokeDeviceSession(session.id, now, 'password_changed')
    }
  }

  async revokeAllDeviceSessions(accountId: string, now: string, reason: string): Promise<void> {
    const sessions = await this.db
      .selectFrom('device_sessions')
      .select('id')
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .execute()
    for (const session of sessions) {
      await this.revokeDeviceSession(session.id, now, reason)
    }
  }

  async listDevices(accountId: string): Promise<Array<{
    id: string
    name: string
    platform: string
    createdAt: string
    lastUsedAt: string
    expiresAt: string
    revokedAt: string | null
  }>> {
    const rows = await this.db
      .selectFrom('device_sessions')
      .select([
        'id',
        'device_name',
        'platform',
        'created_at',
        'last_used_at',
        'expires_at',
        'revoked_at'
      ])
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .orderBy('last_used_at', 'desc')
      .execute()
    return rows.map(row => ({
      id: row.id,
      name: row.device_name,
      platform: row.platform,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at
    }))
  }

  async findInvitation(codeDigest: string): Promise<{
    id: string
    organizationId: string
    expiresAt: string
    maxUses: number
    useCount: number
    status: 'active' | 'revoked' | 'exhausted' | 'expired'
  } | null> {
    const row = await this.db
      .selectFrom('invitations')
      .select(['id', 'organization_id', 'expires_at', 'max_uses', 'use_count', 'status'])
      .where('code_digest', '=', codeDigest)
      .executeTakeFirst()
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
      status: row.status
    } : null
  }

  async consumeInvitation(invitationId: string, expectedUseCount: number): Promise<boolean> {
    const result = await this.db
      .updateTable('invitations')
      .set(expression => ({
        use_count: expression('use_count', '+', 1)
      }))
      .where('id', '=', invitationId)
      .where('status', '=', 'active')
      .where('use_count', '=', expectedUseCount)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async markInvitationExhausted(invitationId: string): Promise<void> {
    await this.db
      .updateTable('invitations')
      .set({ status: 'exhausted' })
      .where('id', '=', invitationId)
      .execute()
  }
}
