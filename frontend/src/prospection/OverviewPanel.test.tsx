import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderApp } from '../test/render'
import { stubProspectionApi } from '../test/prospectionApi'

describe('Bilan de la base', () => {
  it('shows the base, contacted and deleted figures with the share bar', async () => {
    stubProspectionApi()
    renderApp('/prospection')
    expect(await screen.findByText('Prospects actuellement dans la base')).toBeInTheDocument()
    expect(screen.getByText('Contactés')).toBeInTheDocument()
    expect(screen.getByText('Supprimés (déjà retirés de la base)')).toBeInTheDocument()
  })
})
