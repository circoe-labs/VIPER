import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { company } from '../test/companiesApi'
import { companySummary, prospectDetail, stubProspectsApi, trackingDetail } from '../test/prospectsApi'
import { editorReady, showTab } from '../test/prospectEditorUi'
import { renderProspectEditor } from '../test/renderProspectEditor'

const employer = company('Transports Exemple SARL')

async function openSuivi(fields: Parameters<typeof prospectDetail>[0] = {}) {
  const detail = prospectDetail({ company: companySummary(employer), ...fields })
  stubProspectsApi({ details: [detail], companies: [employer] })
  renderProspectEditor(detail.id)
  await editorReady()
  await showTab('Suivi')
  return screen.getByRole('region', { name: 'Synthèse du suivi' })
}

// Slice 6: the Suivi tab opens on a read-only band (state, next action, key dates) above the unchanged cards.
describe('Suivi overview band', () => {
  it('shows state, next action and key dates, then the existing cards', async () => {
    const band = await openSuivi({ tracking: trackingDetail({ status: 'appointment_obtained' }) })
    for (const label of ['État commercial', 'Prochaine action', 'Semaine', 'Réponse', 'Rendez-vous', 'Référent']) {
      expect(within(band).getByText(label)).toBeInTheDocument()
    }
    for (const name of ['Suivi de contact', 'Séquence de contact', 'Notes', 'Alertes qualité', 'Provenance', 'Historique']) {
      expect(await screen.findByRole('region', { name })).toBeInTheDocument()
    }
  })

  it('follows the form: a typed appointment date appears in the band', async () => {
    const band = await openSuivi()
    expect(within(band).getByText('Aucun')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Rendez-vous le'), '2026-10-01')
    expect(within(band).getByText(/01\/10\/2026|1 oct/i)).toBeInTheDocument()
  })
})
