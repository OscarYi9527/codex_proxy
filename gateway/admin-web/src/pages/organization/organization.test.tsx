import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ManagementApiClient } from '../../app/api-client'
import { InvitationsPage } from './InvitationsPage'
import { OrganizationPage } from './OrganizationPage'

function client() {
  return {
    createOrganization: jest.fn(async (name: string) => ({
      id: 'org_created',
      name,
      status: 'active' as const,
      updatedAt: '2026-07-18T00:00:00.000Z',
      version: 1
    })),
    setAccountStatus: jest.fn(async () => undefined),
    createInvitation: jest.fn(async (
      input: Parameters<ManagementApiClient['createInvitation']>[0]
    ) => ({
      code: 'INVITE-ONE-TIME',
      ...input
    })),
    revokeInvitation: jest.fn(async () => undefined)
  }
}

const organizations = [{
  id: 'org_a',
  name: '组织 A',
  status: 'active' as const,
  updatedAt: '2026-07-18T00:00:00.000Z',
  version: 1
}]

describe('organization administration pages (T062/T068)', () => {
  it('lets Level 1 create organizations and manage administrator accounts', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <OrganizationPage
        client={api as unknown as ManagementApiClient}
        role="level1"
        organizations={organizations}
        accounts={[{
          id: 'acct_level2',
          loginName: null,
          email: 'manager@example.test',
          role: 'level2',
          status: 'active',
          organizationId: 'org_a',
          expiresAt: null,
          version: 1
        }]}
        onRefresh={refresh}
      />
    )

    fireEvent.change(screen.getByLabelText('组织名称'), {
      target: { value: '新组织' }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建组织' }))
    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith('新组织'))

    fireEvent.click(screen.getByRole('button', { name: '禁用' }))
    await waitFor(() => expect(api.setAccountStatus).toHaveBeenCalledWith(
      'acct_level2',
      'disabled'
    ))
    expect(screen.getByText(/二级管理员/)).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps organization creation hidden and limits account controls for Level 2', () => {
    const api = client()
    render(
      <OrganizationPage
        client={api as unknown as ManagementApiClient}
        role="level2"
        organizations={organizations}
        accounts={[{
          id: 'acct_level2',
          loginName: null,
          email: 'manager@example.test',
          role: 'level2',
          status: 'active',
          organizationId: 'org_a',
          expiresAt: null,
          version: 1
        }]}
        onRefresh={async () => undefined}
      />
    )

    expect(screen.queryByRole('button', { name: '创建组织' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '禁用' })).not.toBeInTheDocument()
  })

  it('shows a newly created invitation once and supports revocation', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <InvitationsPage
        client={api as unknown as ManagementApiClient}
        role="level2"
        organizations={organizations}
        invitations={[{
          id: 'inv_a',
          organizationId: 'org_a',
          expiresAt: '2026-08-01T00:00:00.000Z',
          maxUses: 2,
          useCount: 0,
          status: 'active',
          createdAt: '2026-07-18T00:00:00.000Z',
          revokedAt: null
        }]}
        onRefresh={refresh}
      />
    )

    expect(screen.getByLabelText('组织')).toBeDisabled()
    expect(screen.getAllByText('组织 A')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('INVITE-ONE-TIME')

    fireEvent.change(screen.getByLabelText('失效时间'), {
      target: { value: '2026-08-01T00:00' }
    })
    fireEvent.change(screen.getByLabelText('可使用次数'), {
      target: { value: '2' }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('INVITE-ONE-TIME')
    expect(api.createInvitation).toHaveBeenCalledWith({
      organizationId: 'org_a',
      expiresAt: '2026-08-01T00:00',
      maxUses: 2
    })

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith('inv_a'))
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
