import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ResultView } from '../api/agents'
import { COMMON, detail, MISSION } from '../missions/missionTestData'
import { SHELL_API } from '../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../test/render'
import { historicalResult, item, RESULT_ID, resultCard, resultPage, resultView } from './reviewTestData'

type User = ReturnType<typeof userEvent.setup>

// The dialog is opened the way a person does it: from a card of the mission's Results tab.
async function openDialog(user: User, view: ResultView, extra: Record<string, ApiReply> = {}) {
  const fetchMock = stubApi({
    ...SHELL_API,
    ...COMMON,
    [`GET /api/missions/${MISSION}`]: [200, detail()],
    [`GET /api/missions/${MISSION}/results`]: [200, resultPage([resultCard({ status: view.status })])],
    [`GET /api/agents/results/${RESULT_ID}`]: [200, view],
    ...extra,
  })
  renderApp(`/missions/${MISSION}?tab=results`)
  await user.click(await screen.findByRole('button', { name: /Mettre à jour la société/ }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText('Confiance globale')
  return { dialog, fetchMock }
}

function posted(fetchMock: ReturnType<typeof stubApi>, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => input.endsWith(path) && init?.method === 'POST')
    .map(([, init]) => JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown)
}

// The table row of one proposed value, found through its selection checkbox.
function rowOf(dialog: HTMLElement, label: string): HTMLElement {
  const row = within(dialog).getByRole('checkbox', { name: label }).closest('tr')
  if (!row) throw new Error(`no row for ${label}`)
  return row
}

describe('ReviewDialog', () => {
  it('puts the global confidence, counts and research report first', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, resultView())

    expect(within(dialog).getByText('Élevée — 88 sur 100')).toBeInTheDocument()
    const summary = within(dialog).getByRole('region', { name: 'Synthèse du résultat' })
    const counts = within(summary).getByRole('list', { name: 'Volume du résultat' })
    expect(counts).toHaveTextContent('2 propositions')
    expect(counts).toHaveTextContent('1 écartée')
    expect(counts).toHaveTextContent('2 sources')
    expect(within(summary).getByText('Rapport de recherche de l’agent')).toBeInTheDocument()
    expect(within(summary).getByText('Deux sources concordantes trouvées.')).toBeInTheDocument()
  })

  it('lays the proposal out as a table: field, before, proposed, confidence, source, published, checked', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, resultView())

    const table = within(dialog).getByRole('table', { name: 'Propositions' })
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual(['Retenir', 'Champ', 'Avant', 'Proposé', 'Confiance', 'Source', 'Publiée', 'Vérifiée'])

    const website = rowOf(dialog, 'Site web')
    expect(within(website).getByText('Élevée · 90 %')).toBeInTheDocument()
    expect(within(website).getByRole('link', { name: 'registre.example/2sn' })).toHaveAttribute('href', 'https://registre.example/2sn')
    expect(within(website).getByText('12 sept. 2026')).toBeInTheDocument()
    expect(within(website).queryByText('ancienne')).not.toBeInTheDocument()
    expect(within(website).getByText(/10 nov. 2026/)).toBeInTheDocument()

    const email = rowOf(dialog, 'Domaine e-mail')
    expect(within(email).getByText('Moyenne · 55 %')).toBeInTheDocument()
    expect(within(email).getByText('ancienne')).toBeInTheDocument() // published in 2019
  })

  it('says which warehouse records accepting a discovered company will create', async () => {
    const user = userEvent.setup()
    const company = item({
      key: 'company:0:exemple',
      label: 'Société Exemple',
      after: 'Nouvelle société',
      store: {
        display_name: 'Société Exemple',
        warehouses_to_create: 1,
        establishments: [
          { name: 'Entrepôt Nord', kind: 'entrepôt', city: 'Ville Exemple', warehouse: { action: 'create' } },
          { name: 'Entrepôt Sud', kind: 'entrepôt', city: 'Ville Exemple', warehouse: { action: 'duplicate', existing_name: 'Dépôt Sud' } },
        ],
      },
    })
    const base = resultView()
    const { dialog } = await openDialog(user, resultView({ proposal: { ...base.proposal, kind: 'find_prospects', items: [company], refused: [] } }))

    expect(within(dialog).getByText('Société + 1 fiche entrepôt')).toBeInTheDocument()
    const sites = within(dialog).getByRole('list', { name: 'Établissements' })
    expect(within(sites).getByText('Entrepôt à créer')).toBeInTheDocument()
    expect(within(sites).getByText(/Entrepôt déjà enregistré : Dépôt Sud/)).toBeInTheDocument()
  })

  it('says what is missing on a result stored before the new fields existed', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, historicalResult())

    const first = rowOf(dialog, 'Site web')
    expect(within(first).getByText('Non renseignée')).toBeInTheDocument()
    expect(within(first).getByText('aucune source')).toBeInTheDocument()
    expect(within(first).getByText('inconnue')).toBeInTheDocument()
    expect(within(first).getByText('non datée')).toBeInTheDocument()
    expect(within(dialog).getByText('L’agent n’a fourni aucun rapport de recherche.')).toBeInTheDocument()
    // the global confidence of a historical result is still shown
    expect(within(dialog).getByText('Moyenne — 70 sur 100')).toBeInTheDocument()
  })

  it('keeps the rejection reason hidden until Rejeter is chosen, then requires it', async () => {
    const user = userEvent.setup()
    const { dialog, fetchMock } = await openDialog(user, resultView(), {
      [`POST /api/agents/results/${RESULT_ID}/reject`]: [200, resultView({ status: 'rejected' })],
    })

    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/Motif/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Rejeter' }))
    const reason = within(dialog).getByRole('textbox', { name: /Motif du rejet/ })
    expect(reason).toHaveFocus()
    expect(within(dialog).queryByRole('button', { name: /Accepter/ })).not.toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Confirmer le rejet' })
    expect(confirm).toBeDisabled()

    await user.type(reason, '  Sources trop anciennes ')
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => {
      expect(posted(fetchMock, `/agents/results/${RESULT_ID}/reject`)).toEqual([{ reason: 'Sources trop anciennes' }])
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('cancelling the rejection hides the reason again and returns focus to Rejeter; Esc backs out first', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, resultView())

    await user.click(within(dialog).getByRole('button', { name: 'Rejeter' }))
    await user.type(within(dialog).getByRole('textbox'), 'brouillon')
    await user.click(within(dialog).getByRole('button', { name: 'Annuler' }))
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Rejeter' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Rejeter' }))
    expect(within(dialog).getByRole('textbox')).toHaveValue('')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('accepts only the selected items and never asks for a reason', async () => {
    const user = userEvent.setup()
    const { dialog, fetchMock } = await openDialog(user, resultView(), {
      [`POST /api/agents/results/${RESULT_ID}/accept`]: [200, resultView({ status: 'accepted' })],
    })

    expect(within(dialog).getByRole('button', { name: 'Accepter la sélection (2)' })).toBeEnabled()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Domaine e-mail' }))
    await user.click(within(dialog).getByRole('button', { name: 'Accepter la sélection (1)' }))

    await waitFor(() => {
      expect(posted(fetchMock, `/agents/results/${RESULT_ID}/accept`)).toEqual([{ accepted_items: ['website_url'] }])
    })
    expect(posted(fetchMock, `/agents/results/${RESULT_ID}/reject`)).toEqual([])
  })

  it('disables the acceptance when nothing is selected', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, resultView())
    await user.click(within(dialog).getByRole('checkbox', { name: 'Site web' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Domaine e-mail' }))
    expect(within(dialog).getByRole('button', { name: 'Accepter la sélection (0)' })).toBeDisabled()
  })

  it('shows the server message when the decision fails and keeps the dialog open', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, resultView(), {
      [`POST /api/agents/results/${RESULT_ID}/accept`]: [409, { detail: { code: 'conflict', message: 'Déjà tranché.' } }],
    })
    await user.click(within(dialog).getByRole('button', { name: /Accepter la sélection/ }))
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('opens a decided result read-only, with the decision and no accept or reject', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(
      user,
      resultView({
        status: 'accepted',
        accepted_items: { keys: ['website_url'] },
        decided_by_display: 'Lucie',
        decided_at: '2026-11-10T10:00:00+00:00',
      }),
    )
    expect(within(dialog).getByText('Validé')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Rejeter' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Accepter/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Site web' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Site web' })).toBeDisabled()
    expect(within(dialog).getByRole('checkbox', { name: 'Domaine e-mail' })).not.toBeChecked()
  })

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    const { dialog } = await openDialog(user, resultView())
    within(dialog).getByRole('button', { name: /Accepter la sélection/ }).focus()
    await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
