import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { fill } from '../test/fill'
import { editorReady, editSection, showTab } from '../test/prospectEditorUi'
import { noteDetail, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'

// The score card inside the Prospect editor: it follows the note writes, its detail leads to the notes, and Escape in
// the detail closes only the detail.

async function open(notes: Parameters<typeof noteDetail>[0][] = []) {
  const detail = prospectDetail()
  const api = stubProspectsApi({ details: [detail], notes: { [detail.id]: notes.map((fields) => noteDetail({ prospect_id: detail.id, ...fields })) } })
  const view = renderProspectEditor(detail.id)
  await editorReady()
  return { api, detail, ...view }
}

const card = () => screen.getByRole('button', { name: /^Score prospect/ })

describe('Prospect editor - score card', () => {
  it('shows the score of the prospect on the Profil tab', async () => {
    await open()

    expect(card()).toHaveAccessibleName('Score prospect : 50 sur 100, niveau moyen. Voir le détail')
    expect(card()).toHaveTextContent('Aucun signal enregistré.')
  })

  it('has no score card for a prospect that is not saved yet', async () => {
    stubProspectsApi()
    renderProspectEditor('new')
    await screen.findByRole('region', { name: 'Identité' })

    expect(screen.queryByRole('region', { name: 'Score prospect' })).not.toBeInTheDocument()
  })

  it('follows a note written with an impact, and the detail then lists it', async () => {
    await open()
    await showTab('Suivi')
    const notes = screen.getByRole('region', { name: 'Notes' })
    await fill(within(notes).getByRole('textbox', { name: 'Nouveau fait' }), 'Demande une démo')
    await userEvent.click(within(notes).getByRole('button', { name: 'Impact sur le score…' }))
    await userEvent.type(within(notes).getByRole('textbox', { name: 'Impact sur le score' }), '25')
    await userEvent.click(within(notes).getByRole('button', { name: 'Ajouter' }))
    await within(notes).findByText('Demande une démo')

    await showTab('Profil')
    await waitFor(() => {
      expect(card()).toHaveAccessibleName('Score prospect : 75 sur 100, niveau élevé. Voir le détail')
    })
    await userEvent.click(card())
    const dialog = screen.getByRole('dialog', { name: 'Détail du score' })
    expect(within(dialog).getByRole('img', { name: '+25 points' })).toBeInTheDocument()
    expect(within(dialog).getByText('Demande une démo')).toBeInTheDocument()
  })

  it('follows the removal of that note', async () => {
    const { api, detail } = await open([{ fact_text: 'Pas intéressé', score_delta: -20 }])
    api.store.set(detail.id, { ...detail, score: { total: 30, summary: 'Un signal.', band: 'red', contributions: [] } })
    await showTab('Suivi')
    await userEvent.click(screen.getByRole('button', { name: /^Actions : Pas intéressé/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Supprimer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer la note' }))

    await showTab('Profil')
    await waitFor(() => {
      expect(card()).toHaveAccessibleName('Score prospect : 50 sur 100, niveau moyen. Voir le détail')
    })
  })

  it('Escape closes the detail alone: the drawer stays, nothing asks to confirm', async () => {
    await open()
    await userEvent.click(card())
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Détail du score' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Identité' })).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(card()).toHaveFocus()
  })

  it('Escape in the detail does not ask to abandon pending changes; a second Escape does', async () => {
    await open()
    await editSection('Identité')
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom' }), 'x')
    await userEvent.click(card())
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Abandonner les modifications ?' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Détail du score' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Abandonner les modifications ?' })).toBeInTheDocument()
  })

  it('Voir la note switches to Suivi, highlights and focuses the note', async () => {
    await open([{ fact_text: 'Appel très positif', score_delta: 10 }, { fact_text: 'Autre fait' }])
    // The stub scores on a write only: save the note again so that its contribution exists.
    await showTab('Suivi')
    await userEvent.click(screen.getByRole('button', { name: /^Actions : Appel très positif/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Modifier' }))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la note' }))
    await showTab('Profil')
    await waitFor(() => {
      expect(card()).toHaveAccessibleName(/60 sur 100/)
    })

    await userEvent.click(card())
    await userEvent.click(screen.getByRole('button', { name: 'Voir la note' }))

    expect(screen.getByRole('tab', { name: /^Suivi/ })).toHaveAttribute('aria-selected', 'true')
    const row = screen.getByText('Appel très positif').closest('li')
    await waitFor(() => {
      expect(row).toHaveFocus()
    })
    expect(row).toHaveAttribute('data-highlight')
  })
})
