import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProspectNote } from '../api/prospectNotes'
import { fill } from '../test/fill'
import { lastBody, noteDetail, prospectDetail, stubProspectsApi, TODAY } from '../test/prospectsApi'
import { editorReady, editSection, showTab } from '../test/prospectEditorUi'
import { fakeQueue, renderProspectEditor } from '../test/renderProspectEditor'

async function open(notes: Partial<ProspectNote>[] = [], options: { notesReply?: [number, unknown] } = {}) {
  const detail = prospectDetail()
  const api = stubProspectsApi({ details: [detail], notes: { [detail.id]: notes.map((fields) => noteDetail({ prospect_id: detail.id, ...fields })) } })
  api.next.notesReply = options.notesReply ?? null
  const queue = fakeQueue([detail.id, 'next-prospect'])
  const view = renderProspectEditor(detail.id, queue.queue)
  await editorReady()
  await showTab('Suivi')
  return { api, detail, ...view }
}

// A pending change of the prospect form (Profil tab), then back on Suivi where the notes are.
async function typeSurname() {
  await showTab('Profil')
  await editSection('Identité')
  await userEvent.type(screen.getByRole('textbox', { name: 'Nom' }), '-Test')
  await showTab('Suivi')
}

function panel() {
  return screen.getByRole('region', { name: 'Notes' })
}

function listItem(element: HTMLElement): HTMLElement {
  const item = element.closest('li')
  if (!item) throw new Error('Not inside a note row.')
  return item
}

function rows() {
  return within(panel()).queryAllByRole('listitem')
}

async function addFact(text: string) {
  await fill(within(panel()).getByRole('textbox', { name: 'Nouveau fait' }), text)
}

describe('Prospect editor — notes list', () => {
  it('shows a compact empty state with the quick add, and no list', async () => {
    await open()

    expect(await within(panel()).findByText('Aucune note pour l’instant.')).toBeInTheDocument()
    expect(within(panel()).queryByRole('list')).not.toBeInTheDocument()
    expect(within(panel()).getByRole('textbox', { name: 'Nouveau fait' })).toBeInTheDocument()
  })

  it('shows one note: the fact, then its date, source and score impact', async () => {
    await open([{ fact_text: 'A liké notre post', noted_on: '2026-09-10', source_type: 'linkedin', source_label: 'post IGuard', score_delta: 5 }])

    const row = (await within(panel()).findAllByRole('listitem'))[0] as HTMLElement
    expect(row).toHaveTextContent('A liké notre post')
    expect(row).toHaveTextContent('10 sept. 2026 · LinkedIn · post IGuard')
    expect(within(row).getByRole('img', { name: 'Impact sur le score : +5' })).toHaveTextContent('+5')
  })

  it('tells a positive, a negative and a null impact by their text, and says when a note has no date or no impact', async () => {
    await open([
      { fact_text: 'Positif', noted_on: '2026-09-10', score_delta: 5 },
      { fact_text: 'Négatif', noted_on: '2026-09-09', score_delta: -10 },
      { fact_text: 'Neutre', noted_on: '2026-09-08', score_delta: 0 },
      { fact_text: 'Sans impact ni date', noted_on: null },
    ])

    await within(panel()).findAllByRole('listitem')
    expect(screen.getByRole('img', { name: 'Impact sur le score : +5' })).toHaveTextContent('+5')
    expect(screen.getByRole('img', { name: 'Impact sur le score : -10' })).toHaveTextContent('-10')
    expect(screen.getByRole('img', { name: 'Impact sur le score : 0' })).toHaveTextContent('0')
    expect(screen.getAllByRole('img', { name: /Impact sur le score/ })).toHaveLength(3)
    expect(rows()[3]).toHaveTextContent('Sans date')
  })

  it('lists many notes in one bounded, focusable scroll area, with their count', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ fact_text: `Fait numéro ${String(index)}`, noted_on: '2026-09-01' }))
    await open(many)

    await within(panel()).findAllByRole('listitem')
    expect(rows()).toHaveLength(40)
    const list = within(panel()).getByRole('list', { name: 'Liste des notes' })
    expect(list).toHaveAttribute('tabindex', '0')
    expect(panel()).toHaveTextContent('40')
  })

  it('keeps a long text whole in the row (wrapping is the style’s job, nothing is cut)', async () => {
    const long = `${'très long fait '.repeat(40)}${'x'.repeat(120)}`.trim()
    await open([{ fact_text: long }])

    const row = (await within(panel()).findAllByRole('listitem'))[0] as HTMLElement
    expect(within(row).getByText(long)).toBeInTheDocument()
  })

  it('says why a prospect not saved yet has no notes', async () => {
    stubProspectsApi()
    renderProspectEditor('new')
    await editorReady()
    await showTab('Suivi')

    expect(await within(await screen.findByRole('region', { name: 'Notes' })).findByText('Possible une fois le prospect enregistré.')).toBeInTheDocument()
  })

  it('says when the notes cannot be loaded and offers to try again', async () => {
    const { api } = await open([{ fact_text: 'Une note' }], { notesReply: [500, 'boom'] })
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Les notes n’ont pas pu être chargées.')

    await userEvent.click(within(panel()).getByRole('button', { name: 'Réessayer' }))

    expect(await within(panel()).findByText('Une note')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.path.endsWith('/notes')).length).toBeGreaterThan(1)
  })
})

describe('Prospect editor — adding a note', () => {
  it('adds with Enter, dated today by default, without saving or leaving the prospect and keeping the form as typed', async () => {
    const { api, detail, onNavigate } = await open()
    await typeSurname()
    await within(panel()).findByText('Aucune note pour l’instant.')

    await addFact('  A demandé une démo  ')
    await userEvent.type(within(panel()).getByRole('textbox', { name: 'Nouveau fait' }), '{Enter}')

    expect(await within(panel()).findByText('A demandé une démo')).toBeInTheDocument()
    expect(lastBody(api.requests, 'POST')).toEqual({ fact_text: 'A demandé une démo', noted_on: TODAY, source_type: null, source_label: null, score_delta: null })
    expect(api.requests.find((request) => request.method === 'POST')?.path).toBe(`/api/prospects/${detail.id}/notes`)
    expect(api.requests.filter((request) => request.method === 'PUT')).toEqual([])
    expect(onNavigate).not.toHaveBeenCalled()
    expect(within(panel()).getByRole('textbox', { name: 'Nouveau fait' })).toHaveValue('')
    expect(within(panel()).getByRole('textbox', { name: 'Nouveau fait' })).toHaveFocus()
    // Only the prospect form's own change is pending: the note is saved.
    expect(screen.getByRole('status')).toHaveTextContent('Modifications non enregistrées')
    await showTab('Profil')
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Exemple-Test')
  })

  it('does not make the editor dirty and does not change the prospect’s version', async () => {
    const { api } = await open()
    await addFact('Fait indépendant')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))

    await within(panel()).findByText('Fait indépendant')
    expect(screen.getByRole('status')).not.toHaveTextContent('Modifications non enregistrées')
    expect(api.requests.filter((request) => request.method === 'POST').every((request) => request.path.endsWith('/notes'))).toBe(true)
  })

  it('adds with the button, a chosen date and a score impact', async () => {
    const { api } = await open()
    await addFact('A refusé le rendez-vous')
    fireEvent.change(within(panel()).getByLabelText('Date du fait'), { target: { value: '2026-09-05' } })
    expect(within(panel()).queryByRole('textbox', { name: 'Impact sur le score' })).not.toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Impact sur le score…' }))
    await userEvent.type(within(panel()).getByRole('textbox', { name: 'Impact sur le score' }), '-10')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))

    const row = listItem(await within(panel()).findByText('A refusé le rendez-vous'))
    expect(row).toHaveTextContent('5 sept. 2026')
    expect(within(row).getByRole('img', { name: 'Impact sur le score : -10' })).toBeInTheDocument()
    expect(lastBody(api.requests, 'POST')).toMatchObject({ noted_on: '2026-09-05', score_delta: -10 })
    // Back to the quick state: today, impact folded away.
    expect(within(panel()).queryByRole('textbox', { name: 'Impact sur le score' })).not.toBeInTheDocument()
  })

  it('adds an undated note when the date is cleared', async () => {
    const { api } = await open()
    await addFact('Sans date')
    fireEvent.change(within(panel()).getByLabelText('Date du fait'), { target: { value: '' } })
    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))

    expect(await within(panel()).findByText('Sans date', { selector: '.prospect-note__fact' })).toBeInTheDocument()
    expect(lastBody(api.requests, 'POST')).toMatchObject({ noted_on: null })
  })

  it('adds a typed note with Ctrl+Entrée instead of saving and moving on', async () => {
    const { api, onNavigate } = await open()
    await typeSurname()
    await addFact('Ne pas perdre ce fait')

    await userEvent.type(within(panel()).getByRole('textbox', { name: 'Nouveau fait' }), '{Control>}{Enter}{/Control}')

    expect(await within(panel()).findByText('Ne pas perdre ce fait')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.method === 'PUT')).toEqual([])
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('refuses a blank fact and an impact out of range before sending anything', async () => {
    const { api } = await open()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))
    expect(await within(panel()).findByText('Saisissez le fait.')).toBeInTheDocument()

    await addFact('Un fait')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Impact sur le score…' }))
    await userEvent.type(within(panel()).getByRole('textbox', { name: 'Impact sur le score' }), '80')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))

    expect(await within(panel()).findByText('Un entier de -50 à +50.')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.method === 'POST')).toEqual([])
  })

  it('shows the server’s refusal, keeps what was typed and releases the button', async () => {
    const { api } = await open()
    await addFact('Fait refusé')
    api.next.notesReply = [422, { code: 'invalid', field: 'fact_text', reason: 'length', message: 'too long' }]

    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))

    expect(await within(panel()).findByRole('alert')).toHaveTextContent('1000 caractères au plus.')
    expect(within(panel()).getByRole('textbox', { name: 'Nouveau fait' })).toHaveValue('Fait refusé')
    expect(within(panel()).getByRole('button', { name: 'Ajouter' })).toBeEnabled()
    expect(rows()).toHaveLength(0)
  })

  it('says it plainly when the request fails for another reason', async () => {
    const { api } = await open()
    await addFact('Fait perdu')
    api.next.notesReply = [500, 'Internal Server Error']

    await userEvent.click(within(panel()).getByRole('button', { name: 'Ajouter' }))

    expect(await within(panel()).findByRole('alert')).toHaveTextContent('L’opération sur la note a échoué')
    expect(within(panel()).getByRole('textbox', { name: 'Nouveau fait' })).toHaveValue('Fait perdu')
  })
})

describe('Prospect editor — editing and deleting a note', () => {
  async function openMenu(fact: string) {
    const row = listItem(await within(panel()).findByText(fact))
    await userEvent.click(within(row).getByRole('button', { name: new RegExp(`^Actions : ${fact}`) }))
  }

  it('edits in place, saves with Enter and shows the new values', async () => {
    const { api, detail } = await open([{ fact_text: 'Ancien fait', noted_on: '2026-09-10', score_delta: 5 }])
    await openMenu('Ancien fait')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Modifier' }))

    const fact = within(panel()).getByRole('textbox', { name: 'Fait' })
    expect(fact).toHaveFocus()
    expect(within(panel()).getByRole('textbox', { name: 'Impact sur le score' })).toHaveValue('5')
    await fill(fact, 'Fait corrigé')
    await fill(within(panel()).getByRole('textbox', { name: 'Impact sur le score' }), '')
    await userEvent.selectOptions(within(panel()).getByRole('combobox', { name: 'Source' }), 'meeting')
    await userEvent.type(fact, '{Enter}')

    expect(await within(panel()).findByText('Fait corrigé')).toBeInTheDocument()
    expect(api.requests.find((request) => request.method === 'PATCH')?.path).toMatch(new RegExp(`^/api/prospects/${detail.id}/notes/`))
    expect(lastBody(api.requests, 'PATCH')).toEqual({
      fact_text: 'Fait corrigé',
      noted_on: '2026-09-10',
      source_type: 'meeting',
      source_label: null,
      score_delta: null,
    })
    expect(within(panel()).queryByRole('img', { name: /Impact sur le score/ })).not.toBeInTheDocument()
    expect(rows()[0]).toHaveTextContent('Rendez-vous')
  })

  it('cancels an edit with Échap without closing the editor, and sends nothing', async () => {
    const { api } = await open([{ fact_text: 'Fait stable' }])
    await openMenu('Fait stable')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Modifier' }))
    await userEvent.type(within(panel()).getByRole('textbox', { name: 'Fait' }), ' modifié{Escape}')

    expect(await within(panel()).findByText('Fait stable')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.method === 'PATCH')).toEqual([])
  })

  it('keeps the edit open with the server’s message when the save fails', async () => {
    const { api } = await open([{ fact_text: 'Fait à corriger' }])
    await openMenu('Fait à corriger')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Modifier' }))
    api.next.notesReply = [404, { code: 'not_found', message: 'gone' }]

    await userEvent.click(within(panel()).getByRole('button', { name: 'Enregistrer la note' }))

    expect(await within(panel()).findByRole('alert')).toHaveTextContent('n’existe plus')
    expect(within(panel()).getByRole('textbox', { name: 'Fait' })).toHaveValue('Fait à corriger')
  })

  it('asks before deleting, then deletes', async () => {
    const { api } = await open([{ fact_text: 'À supprimer', score_delta: 5 }, { fact_text: 'À garder', noted_on: '2026-01-01' }])
    await openMenu('À supprimer')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Supprimer' }))

    const dialog = screen.getByRole('dialog', { name: 'Supprimer cette note ?' })
    expect(dialog).toHaveTextContent('À supprimer')
    expect(dialog).toHaveTextContent('Son impact sur le score (+5) disparaîtra avec elle.')
    expect(within(dialog).getByRole('button', { name: 'Retour' })).toHaveFocus()
    expect(api.requests.filter((request) => request.method === 'DELETE')).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer la note' }))

    expect(await within(panel()).findByText('À garder')).toBeInTheDocument()
    expect(within(panel()).queryByText('À supprimer')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Supprimer cette note ?' })).not.toBeInTheDocument()
    expect(api.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1)
  })

  it('keeps the note and says why when the deletion fails', async () => {
    const { api } = await open([{ fact_text: 'Reste là' }])
    await openMenu('Reste là')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Supprimer' }))
    api.next.notesReply = [500, 'boom']

    const dialog = screen.getByRole('dialog', { name: 'Supprimer cette note ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer la note' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('L’opération sur la note a échoué')
    expect(within(dialog).getByRole('button', { name: 'Supprimer la note' })).toBeEnabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retour' }))
    expect(within(panel()).getByText('Reste là')).toBeInTheDocument()
  })

  it('reaches every row’s actions from the keyboard', async () => {
    await open([{ fact_text: 'Premier' }, { fact_text: 'Second', noted_on: '2026-01-01' }])
    await within(panel()).findByText('Second')

    const buttons = within(panel()).getAllByRole('button', { name: /^Actions : / })
    expect(buttons).toHaveLength(2)
    const second = buttons[1] as HTMLElement
    second.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Modifier' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(second).toHaveFocus()
  })
})
