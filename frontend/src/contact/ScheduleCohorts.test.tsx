import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ScheduleCohorts } from './ScheduleCohorts'

describe('ScheduleCohorts', () => {
  it('offers the three e-mails of a sequence and nothing after R2', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ScheduleCohorts cohort="S41" />
      </QueryClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Programmer les mails' }))
    const steps = within(await screen.findByRole('group', { name: 'Étape' })).getAllByRole('radio')
    expect(steps.map((radio) => radio.closest('label')?.textContent)).toEqual(['Contact', 'R1', 'R2'])
  })
})
