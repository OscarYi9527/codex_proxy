import { jest } from '@jest/globals'
import { managementApi } from './api-client'

describe('management audit API client', () => {
  const fetchMock = jest.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [], events: [] })
    } as Response)
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })
  })

  it('uses scoped, encoded audit list and detail routes', async () => {
    await managementApi.conversationAudits('org /中文')
    await managementApi.conversationAudit('audit /中文')
    await managementApi.adminAuditEvents('org /中文')

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/v1/admin/audit/conversations?organizationId=org%20%2F%E4%B8%AD%E6%96%87',
      '/api/v1/admin/audit/conversations/audit%20%2F%E4%B8%AD%E6%96%87',
      '/api/v1/admin/audit/admin-events?organizationId=org%20%2F%E4%B8%AD%E6%96%87'
    ])
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ credentials: 'include' })
    }
  })

  it('writes only the validated retention day value to the selected organization', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true } as Response)
    await managementApi.setAuditRetention('org_test', 45)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/organizations/org_test/audit-retention',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ days: 45 })
      })
    )
  })
})
