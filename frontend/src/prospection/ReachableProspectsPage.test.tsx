import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { prospect, stubProspectionApi } from '../test/prospectionApi'
import { renderApp } from '../test/render'

function people() {
  return [
    prospect('Anne', 'Validee', { review: 'verified', employment_verified_at: '2026-10-29T09:00:00Z', primary_email: 'anne@example.test', email_state: 'verified' }),
    prospect('Bruno', 'Joignable', { review: 'to_verify', employment_verified_at: '2026-10-29T09:00:00Z', primary_email: 'bruno@example.test', email_state: 'unverified' }),
    prospect('Claire', 'Telephone', { employment_verified_at: '2026-10-29T09:00:00Z' }),
    prospect('David', 'Ignore', { review: 'ignored', employment_verified_at: '2026-10-29T09:00:00Z' }),
    prospect('Edith', 'Incertaine', { primary_email: 'edith@example.test' }),
  ]
}

describe('Validated prospects: a plain filter of the Prospection list', () => {
  it('keeps the original prospection page and all its records available', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')
    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Prestations proposées' })).not.toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Prospects' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
  })

  it('/contacts-joignables opens the prospects list restricted to validated jobs, in the same layout', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/contacts-joignables')
    const list = await screen.findByRole('list', { name: 'Prospects' })
    await waitFor(() => { expect(within(list).getAllByRole('listitem')).toHaveLength(3) })
    expect(screen.queryByRole('table', { name: 'Prospects' })).not.toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'Bruno Joignable' })).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'Claire Telephone' })).toBeInTheDocument()
    expect(within(list).queryByText('David Ignore')).not.toBeInTheDocument()
    expect(within(list).queryByText('Edith Incertaine')).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Filtres appliqués' })).getByText('Emploi validé')).toBeVisible()
  })

  it('searches within the validated scope, and « Tout effacer » returns to the whole base', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/contacts-joignables')
    await screen.findByRole('list', { name: 'Prospects' })
    await userEvent.type(screen.getByRole('searchbox', { name: /Rechercher un prospect/ }), 'Bruno')
    await waitFor(() => { expect(within(screen.getByRole('list', { name: 'Prospects' })).getAllByRole('listitem')).toHaveLength(1) })
    await userEvent.click(screen.getByRole('button', { name: 'Tout effacer' }))
    await waitFor(() => { expect(within(screen.getByRole('list', { name: 'Prospects' })).getAllByRole('listitem')).toHaveLength(1) })
    // Only the filters are cleared: the search stays in the box, the validated restriction is gone.
    expect(screen.getByRole('searchbox')).toHaveValue('Bruno')
    expect(screen.queryByRole('button', { name: /Retirer le filtre/ })).not.toBeInTheDocument()
  })
})
