import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { fakeQueue, renderProspectEditor } from '../test/renderProspectEditor'

const employer = company('Transports Exemple SARL')

describe('Prospect editor — Save & Next', () => {
  it('saves, then opens the next person of the list’s queue', async () => {
    const first = prospectDetail({ first_name: 'Anne', last_name: 'Premier', company: companySummary(employer) })
    const second = prospectDetail({ first_name: 'Bruno', last_name: 'Second', company: companySummary(employer) })
    const api = stubProspectsApi({ details: [first, second], companies: [employer] })
    const { queue, next } = fakeQueue([first.id, second.id])
    const { onNavigate } = renderProspectEditor(first.id, queue)
    await screen.findByRole('dialog', { name: 'Anne Premier' })

    await userEvent.click(screen.getByRole('button', { name: 'Vérifié aujourd’hui' }))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer et suivant' }))

    expect(await screen.findByRole('dialog', { name: 'Bruno Second' })).toHaveAccessibleDescription(
      'Prospect 2 sur 2 · Jamais vérifiés',
    )
    expect((lastBody(api.requests, 'PUT') as ProspectInput).employment_verification).toEqual({ action: 'verified_now', day: null })
    expect(next).toHaveBeenCalledWith(first.id)
    expect(onNavigate).toHaveBeenCalledWith(second.id, { page: 1 })
    expect(await screen.findByRole('textbox', { name: 'Prénom' })).toHaveValue('Bruno')
  })

  it('moves on with Ctrl+Entrée without saving when nothing changed, and says when the list ends', async () => {
    const only = prospectDetail({ first_name: 'Anne', last_name: 'Seule' })
    const api = stubProspectsApi({ details: [only] })
    renderProspectEditor(only.id)
    await screen.findByRole('textbox', { name: 'Prénom' })

    await userEvent.keyboard('{Control>}{Enter}{/Control}')

    expect(await screen.findByText('Fin de la liste « Jamais vérifiés » : aucun prospect après celui-ci.')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.method === 'PUT')).toEqual([])
  })
})
