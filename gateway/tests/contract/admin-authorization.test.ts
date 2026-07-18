import { SafeError } from '../../src/common/errors.js'
import {
  assertLevel1CanBeChanged,
  requireAccountManager,
  requireLevel1,
  requireOrganizationManager
} from '../../src/organizations/authorization-policy.js'
import type { AccessIdentity } from '../../src/auth/types.js'

const level1: AccessIdentity = {
  accountId: 'acct_level1',
  deviceSessionId: 'ds_level1',
  role: 'level1',
  organizationId: null,
  accountVersion: 1,
  passwordVersion: 1
}

const level2: AccessIdentity = {
  accountId: 'acct_level2',
  deviceSessionId: 'ds_level2',
  role: 'level2',
  organizationId: 'org_a',
  accountVersion: 1,
  passwordVersion: 1
}

const user: AccessIdentity = {
  ...level2,
  accountId: 'acct_user',
  deviceSessionId: 'ds_user',
  role: 'user'
}

function expectSafeError(
  operation: () => void,
  code: 'forbidden' | 'last_level1_protected'
): void {
  expect(operation).toThrow(SafeError)
  try {
    operation()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('organization administration authorization (T060/T064)', () => {
  it('permits Level 1 administration and rejects lower roles', () => {
    expect(() => requireLevel1(level1)).not.toThrow()
    expectSafeError(() => requireLevel1(level2), 'forbidden')
    expectSafeError(() => requireLevel1(user), 'forbidden')
  })

  it('scopes Level 2 managers to their own organization', () => {
    expect(() => requireOrganizationManager(level1, 'org_b')).not.toThrow()
    expect(() => requireOrganizationManager(level2, 'org_a')).not.toThrow()
    expectSafeError(() => requireOrganizationManager(level2, 'org_b'), 'forbidden')
    expectSafeError(() => requireOrganizationManager(user, 'org_a'), 'forbidden')
  })

  it('allows Level 2 managers to manage only ordinary users in their own organization', () => {
    expect(() => requireAccountManager(level2, {
      id: 'acct_org_a_user',
      role: 'user',
      organizationId: 'org_a'
    })).not.toThrow()
    expectSafeError(() => requireAccountManager(level2, {
      id: 'acct_org_a_level2',
      role: 'level2',
      organizationId: 'org_a'
    }), 'forbidden')
    expectSafeError(() => requireAccountManager(level2, {
      id: 'acct_org_b_user',
      role: 'user',
      organizationId: 'org_b'
    }), 'forbidden')
  })

  it('protects the last active Level 1 administrator', () => {
    expectSafeError(() => assertLevel1CanBeChanged({
      id: 'acct_only_level1',
      role: 'level1',
      organizationId: null
    }, 1), 'last_level1_protected')
    expect(() => assertLevel1CanBeChanged({
      id: 'acct_second_level1',
      role: 'level1',
      organizationId: null
    }, 2)).not.toThrow()
  })
})
