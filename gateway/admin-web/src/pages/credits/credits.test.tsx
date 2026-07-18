import { jest } from '@jest/globals'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ManagementApiClient } from '../../app/api-client'
import { CreditManagementPage } from './CreditManagementPage'
import type { OrganizationCreditView } from '../../app/types'

const baseView: OrganizationCreditView = {
  organization: { id: 'org_a', name: '组织 A' },
  period: {
    id: 'period_a',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    allocated: '1000.000000',
    settled: '100.000000',
    available: '900.000000'
  },
  users: [{
    accountId: 'acct_a',
    display: 'user@example.test',
    allocated: '500.000000',
    settled: '100.000000',
    available: '400.000000',
    requests: 2,
    inputTokens: 120,
    outputTokens: 80
  }],
  usage: {
    requests: 2,
    inputTokens: 120,
    outputTokens: 80,
    settledCredits: '100.000000'
  }
}

function client() {
  return {
    setMonthlyCredits: jest.fn(async () => undefined),
    setUserCreditAllocation: jest.fn(async () => undefined),
    setRiskPolicy: jest.fn(async () => undefined)
  }
}

describe('role-filtered credit management (T072/T080)', () => {
  it('lets Level 2 allocate user credits without exposing rates or risk', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <CreditManagementPage
        client={api as unknown as ManagementApiClient}
        role="level2"
        views={[baseView]}
        onRefresh={refresh}
      />
    )
    expect(screen.queryByText('模型费率')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('单次最大透支积分')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('组织月度总积分')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('用户积分 user@example.test'), {
      target: { value: '550' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存用户积分' }))
    await waitFor(() => expect(api.setUserCreditAllocation).toHaveBeenCalledWith(
      'acct_a',
      '550'
    ))
  })

  it('shows Level-1-only rates and risk policy controls', async () => {
    const api = client()
    const refresh = jest.fn(async () => undefined)
    render(
      <CreditManagementPage
        client={api as unknown as ManagementApiClient}
        role="level1"
        views={[{
          ...baseView,
          riskPolicy: {
            maxOverdraftPerTurn: '50.000000',
            maxCumulativeRisk: '200.000000',
            activeRiskCredits: '12.000000'
          },
          modelRates: [{
            modelId: 'credit-test-model',
            inputCreditPerToken: '0.001000',
            outputCreditPerToken: '0.002000',
            multiplier: '1.500000'
          }]
        }]}
        onRefresh={refresh}
      />
    )
    expect(screen.getByText('模型费率')).toBeInTheDocument()
    expect(screen.getByText('1.500000×')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('组织月度总积分'), {
      target: { value: '1200' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存月度总积分' }))
    await waitFor(() => expect(api.setMonthlyCredits).toHaveBeenCalledWith(
      'org_a',
      '1200'
    ))
  })
})
