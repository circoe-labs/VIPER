import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { company } from '../test/companiesApi'
import { companySummary, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { fakeQueue, renderProspectEditor } from '../test/renderProspectEditor'

const employer = company('Transports Exemple SARL')

describe('Prospect editor — browsing the list', () => {
  it('has no « Fermer » nor « Enregistrer et suivant » button, only the cross and the arrows', async () => {
    const first = prospectDetail({ first_name: 'Anne', last_name: 'Premier', company: companySummary(employer) })
    stubProspectsApi({ details: [first], companies: [employer] })
    renderProspectEditor(first.id, fakeQueue([first.id]).queue)
    await screen.findByRole('dialog', { name: 'Anne Premier' })

    expect(screen.queryByRole('button', { name: 'Enregistrer et suivant' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Fermer' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Prospect précédent' })).toBeInTheDocument()
  })

  it('moves to the next person of the list’s queue with the arrow', async () => {
    const first = prospectDetail({ first_name: 'Anne', last_name: 'Premier', company: companySummary(employer) })
    const second = prospectDetail({ first_name: 'Bruno', last_name: 'Second', company: companySummary(employer) })
    stubProspectsApi({ details: [first, second], companies: [employer] })
    const { queue, next } = fakeQueue([first.id, second.id])
    const { onNavigate } = renderProspectEditor(first.id, queue)
    await screen.findByRole('dialog', { name: 'Anne Premier' })

    await userEvent.click(screen.getByRole('button', { name: 'Prospect suivant' }))

    expect(next).toHaveBeenCalledWith(first.id)
    expect(onNavigate).toHaveBeenCalledWith(second.id, { page: 1 })
  })

  it('moves back with the other arrow, which is disabled on the first person', async () => {
    const first = prospectDetail({ first_name: 'Anne', last_name: 'Premier' })
    const second = prospectDetail({ first_name: 'Bruno', last_name: 'Second' })
    stubProspectsApi({ details: [first, second] })
    const { onNavigate } = renderProspectEditor(second.id, fakeQueue([first.id, second.id]).queue)
    await screen.findByRole('dialog', { name: 'Bruno Second' })

    await userEvent.click(screen.getByRole('button', { name: 'Prospect précédent' }))

    expect(onNavigate).toHaveBeenCalledWith(first.id, { page: 1 })
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
