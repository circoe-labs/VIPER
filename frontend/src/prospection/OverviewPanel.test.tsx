import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { renderApp } from '../test/render'
import { prospect, stubProspectionApi } from '../test/prospectionApi'

describe('Bilan de la base', () => {
  it('separates the global overview from the filtered work counters and archived deletions', async () => {
    stubProspectionApi({ prospects: [prospect('Alice', 'Exemple')] })
    renderApp('/prospection')
    expect(await screen.findByRole('heading', { name: 'Vue d’ensemble' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Avec un échange/ })).toHaveAttribute('href', '/prospection?segment=contacted')
    expect(screen.getByText('Toute la base · hors filtres')).toBeInTheDocument()
    expect(await screen.findByText(/prospects supprimés depuis l’origine, déjà exclus/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Prospects' })).not.toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('region', { name: 'Vue d’ensemble' })).getByRole('link', { name: /^Prospects/ }))
    expect(await screen.findByRole('list', { name: 'Prospects' })).toBeVisible()
  })
})
