import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { prospect } from '../test/prospectionApi'
import { lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderApp } from '../test/render'

function setup() {
  const anne = prospectDetail({ first_name: 'Anne', last_name: 'Premier' })
  const bruno = prospectDetail({ first_name: 'Bruno', last_name: 'Second' })
  const rows = [
    prospect('Anne', 'Premier', { id: anne.id, review: 'verified', company_name: 'Transports Exemple' }),
    prospect('Bruno', 'Second', { id: bruno.id, review: 'verified', company_name: 'Port Exemple' }),
    prospect('Claire', 'Inconnue', { review: 'to_verify' }),
  ]
  const notes = {
    [bruno.id]: [
      {
        id: 'note-1',
        prospect_id: bruno.id,
        fact_text: 'Ne connaît pas Robin',
        noted_on: '2026-10-01',
        source_type: null,
        source_label: null,
        score_delta: null,
        created_at: '2026-10-01T09:00:00+00:00',
        updated_at: '2026-10-01T09:00:00+00:00',
      },
    ],
  }
  const api = stubProspectsApi({ details: [anne, bruno], rows, notes })
  return { api, anne, bruno }
}

describe('Qui connaît Robin ?', () => {
  it('lists only the valid prospects and shows the recorded answer', async () => {
    setup()
    renderApp('/prospection/robin')

    expect(await screen.findByText('Anne Premier')).toBeInTheDocument()
    expect(screen.getByText('Bruno Second')).toBeInTheDocument()
    expect(screen.queryByText('Claire Inconnue')).not.toBeInTheDocument()
    expect(screen.getByText(/2 prospects valides/)).toBeInTheDocument()

    const bruno = within(screen.getByRole('group', { name: 'Robin : Bruno Second' }))
    expect(await bruno.findByRole('button', { name: 'Ne connaît pas' })).toHaveAttribute('aria-pressed', 'true')
    expect(bruno.getByRole('button', { name: 'Connaît' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('writes a dated note when a choice is made and shows it as selected', async () => {
    const { api } = setup()
    renderApp('/prospection/robin')
    const user = userEvent.setup()

    const group = within(await screen.findByRole('group', { name: 'Robin : Anne Premier' }))
    const knows = await group.findByRole('button', { name: 'Connaît' })
    await user.click(knows)

    expect(lastBody(api.requests, 'POST')).toMatchObject({ fact_text: 'Connaît Robin' })
    expect(await group.findByRole('button', { name: 'Connaît' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('adds a free remark and shows it', async () => {
    const { api } = setup()
    renderApp('/prospection/robin')
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('Remarque pour Anne Premier'), 'Rencontrée au salon')
    await user.click(within(screen.getByRole('row', { name: /Anne Premier/ })).getByRole('button', { name: 'Ajouter' }))

    expect(lastBody(api.requests, 'POST')).toMatchObject({ fact_text: 'Rencontrée au salon' })
    expect(await screen.findByText('Rencontrée au salon')).toBeInTheDocument()
  })
})
