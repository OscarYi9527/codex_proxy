import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('Gateway admin shell', () => {
  it('renders a safe placeholder without credentials or provider details', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'AI Editor 管理' })).toBeInTheDocument()
    expect(screen.getByText(/基础框架已启动/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/api[_-]?key|refresh token/i)
  })
})
