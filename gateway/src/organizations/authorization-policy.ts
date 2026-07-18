import { SafeError } from '../common/errors.js'
import type { AccessIdentity, AccountRole } from '../auth/types.js'

export interface ScopedAccount {
  readonly id: string
  readonly role: AccountRole
  readonly organizationId: string | null
}

function forbidden(): SafeError {
  return new SafeError({
    code: 'forbidden',
    message: '无权执行此管理操作。',
    statusCode: 403
  })
}

export function requireLevel1(identity: AccessIdentity): void {
  if (identity.role !== 'level1') throw forbidden()
}

export function requireOrganizationManager(
  identity: AccessIdentity,
  organizationId: string
): void {
  if (identity.role === 'level1') return
  if (identity.role === 'level2' && identity.organizationId === organizationId) return
  throw forbidden()
}

export function requireAccountManager(
  identity: AccessIdentity,
  account: ScopedAccount
): void {
  if (identity.role === 'level1') return
  if (
    identity.role === 'level2' &&
    identity.organizationId !== null &&
    identity.organizationId === account.organizationId &&
    account.role === 'user'
  ) {
    return
  }
  throw forbidden()
}

export function assertLevel1CanBeChanged(
  account: ScopedAccount,
  activeLevel1Count: number
): void {
  if (account.role === 'level1' && activeLevel1Count <= 1) {
    throw new SafeError({
      code: 'last_level1_protected',
      message: '不能禁用或降级最后一个有效一级管理员。',
      statusCode: 409
    })
  }
}
