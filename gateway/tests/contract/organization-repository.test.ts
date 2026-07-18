import { OrganizationRepository } from '../../src/db/repositories/organization-repository.js'
import { createRealGatewayFixture, type RealGatewayFixture } from '../helpers/auth-fixture.js'

describe('organization repository scope boundaries (T063)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
    await fixture.database.db.insertInto('organizations').values([
      {
        id: 'org_a',
        name: 'Organization A',
        status: 'active',
        billing_timezone: 'UTC',
        audit_retention_days: 30,
        overdraft_per_turn_override: null,
        cumulative_risk_override: null,
        created_at: '2026-07-18T00:00:00.000Z',
        updated_at: '2026-07-18T00:00:00.000Z',
        version: 1
      },
      {
        id: 'org_b',
        name: 'Organization B',
        status: 'active',
        billing_timezone: 'UTC',
        audit_retention_days: 30,
        overdraft_per_turn_override: null,
        cumulative_risk_override: null,
        created_at: '2026-07-18T00:00:00.000Z',
        updated_at: '2026-07-18T00:00:00.000Z',
        version: 1
      }
    ]).execute()
    await fixture.database.db.insertInto('accounts').values([
      {
        id: 'acct_org_a_user',
        login_name: 'org-a-user',
        email: 'org-a@example.test',
        role: 'user',
        organization_id: 'org_a',
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: '2026-07-18T00:00:00.000Z',
        updated_at: '2026-07-18T00:00:00.000Z',
        disabled_at: null,
        disabled_by: null,
        version: 1
      },
      {
        id: 'acct_org_b_user',
        login_name: 'org-b-user',
        email: 'org-b@example.test',
        role: 'user',
        organization_id: 'org_b',
        status: 'active',
        expires_at: null,
        must_change_password: 0,
        must_provide_email: 0,
        created_at: '2026-07-18T00:00:00.000Z',
        updated_at: '2026-07-18T00:00:00.000Z',
        disabled_at: null,
        disabled_by: null,
        version: 1
      }
    ]).execute()
  })

  afterEach(async () => fixture.gateway.close())

  it('lists only accounts in the requested organization', async () => {
    const noTransaction = async <T>(
      _operation: (repository: OrganizationRepository) => Promise<T>
    ): Promise<T> => {
      throw new Error('This repository scope test does not open a transaction')
    }
    const repository = new OrganizationRepository(
      fixture.database.db,
      noTransaction
    )

    await expect(repository.listAccountsForOrganization('org_a')).resolves.toEqual([
      expect.objectContaining({ id: 'acct_org_a_user', organizationId: 'org_a' })
    ])
    await expect(repository.listAccountsForOrganization('org_b')).resolves.toEqual([
      expect.objectContaining({ id: 'acct_org_b_user', organizationId: 'org_b' })
    ])
  })
})
