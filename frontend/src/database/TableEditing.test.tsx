import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import type { DeleteCheck } from '../api/explorer'
import {
  COMPANY_IDS,
  companiesTable,
  companyRows,
  page,
  prospectRows,
  prospectsTable,
  TABLES,
} from '../test/explorerFixtures'
import { company, stubCompaniesApi } from '../test/companiesApi'
import { fill } from '../test/fill'
import { type ApiReply, renderApp, stubApi } from '../test/render'

const API = '/api/explorer/tables'
const CASCADE: DeleteCheck = {
  rows: 1,
  allowed: true,
  blockers: [],
  effects: [{ table: 'establishments', column: 'company_id', action: 'cascade', count: 1, depth: 1 }],
}

function stubExplorer(extra: Record<string, ApiReply> = {}) {
  return stubApi({
    'GET /api/health': [200, { status: 'ok', database: 'ok' }],
    [`GET ${API}`]: [200, TABLES],
    [`GET ${API}/companies`]: [200, companiesTable],
    [`GET ${API}/prospects`]: [200, prospectsTable],
    [`GET ${API}/companies/rows`]: [200, page(companyRows)],
    [`GET ${API}/prospects/rows`]: [200, page(prospectRows)],
    [`GET ${API}/companies/delete-check`]: [200, CASCADE],
    [`POST ${API}/companies/changes`]: [200, { updated: 1, inserted: 0, deleted: 0, inserted_keys: [] }],
    ...extra,
  })
}

async function cellOf(table: string, position: string): Promise<HTMLElement> {
  const grid = await screen.findByRole('grid', { name: `Lignes de ${table}` })
  const cell = (await within(grid).findAllByRole('gridcell')).find((item) => item.dataset.cell === position)
  if (!cell) throw new Error(`cell ${position} not rendered`)
  return cell
}

// Double-click the cell and type a new text value, then press Enter.
async function editText(cell: HTMLElement, column: string, text: string) {
  await userEvent.dblClick(cell)
  const input = within(cell).getByRole('textbox', { name: `Nouvelle valeur de ${column}` })
  await fill(input, text)
  await userEvent.keyboard('{Enter}')
}

function pendingBar() {
  return screen.getByRole('region', { name: 'Modifications en attente' })
}

function changeRequests(fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => input.endsWith('/changes') && init?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown)
}

describe('Database explorer editing', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
  })

  it('stages an edit with a visible marker, and Cancel restores the original value', async () => {
    stubExplorer()
    renderApp('/database/companies')
    const cell = await cellOf('companies', '1:1')

    await editText(cell, 'display_name', 'Autre SAS')

    expect(cell).toHaveTextContent('Modifiée : Autre SAS')
    expect(cell).toHaveAttribute('data-dirty')
    expect(within(pendingBar()).getByText('1 modification en attente')).toBeInTheDocument()
    expect(within(pendingBar()).getByText('1 cellule modifiée')).toBeInTheDocument()

    await userEvent.click(within(pendingBar()).getByRole('button', { name: 'Annuler' }))

    expect(screen.queryByRole('region', { name: 'Modifications en attente' })).not.toBeInTheDocument()
    expect(cell).toHaveTextContent(/^Logistique Démo SAS$/)
  })

  it('Esc leaves the editor without staging anything', async () => {
    stubExplorer()
    renderApp('/database/companies')
    const cell = await cellOf('companies', '1:1')

    await userEvent.dblClick(cell)
    await userEvent.type(within(cell).getByRole('textbox'), ' modifié{Escape}')

    expect(within(cell).queryByRole('textbox')).not.toBeInTheDocument()
    expect(cell).toHaveTextContent(/^Logistique Démo SAS$/)
    expect(screen.queryByRole('region', { name: 'Modifications en attente' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(cell).toHaveFocus()
    })
  })

  it('saves the change set with the row version and reloads the rows', async () => {
    const fetchMock = stubExplorer()
    renderApp('/database/companies')
    const cell = await cellOf('companies', '1:2')

    await editText(cell, 'size_label', '')
    await userEvent.click(within(pendingBar()).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Modifications en attente' })).not.toBeInTheDocument()
    })
    expect(changeRequests(fetchMock)).toEqual([
      {
        updates: [{ key: { id: COMPANY_IDS[1] }, version: '2026-09-02T09:30:00Z', values: { size_label: null } }],
        inserts: [],
        deletes: [],
      },
    ])
    expect(await screen.findByText(/inscrite\(s\) au journal d’audit/)).toBeInTheDocument()
    const rowLoads = fetchMock.mock.calls.filter(([input]) => input.startsWith(`${API}/companies/rows`))
    expect(rowLoads.length).toBeGreaterThan(1)
  })

  it('shows every server error on its cell and keeps the changes', async () => {
    const refusal = {
      detail: {
        message: '1 erreur(s) : aucune modification n’a été enregistrée.',
        errors: [
          { operation: 'update', index: 0, column: 'display_name', code: 'check_violation', message: 'Le nom ne peut pas être vide.' },
        ],
      },
    }
    stubExplorer({ [`POST ${API}/companies/changes`]: [422, refusal] })
    renderApp('/database/companies')
    const cell = await cellOf('companies', '1:1')

    await editText(cell, 'display_name', '   ')
    await userEvent.click(within(pendingBar()).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(pendingBar()).findByText('Enregistrement refusé : 1 erreur')).toBeInTheDocument()
    expect(cell).toHaveAttribute('data-invalid')
    expect(cell).toHaveTextContent('Erreur : Le nom ne peut pas être vide.')

    await userEvent.click(within(pendingBar()).getByRole('button', { name: 'Voir le détail' }))
    const review = screen.getByRole('dialog', { name: 'Modifications en attente' })
    expect(within(review).getByText('Le nom ne peut pas être vide.')).toBeInTheDocument()
  })

  it('warns before leaving the table with pending changes', async () => {
    stubExplorer()
    renderApp('/database/companies')
    await editText(await cellOf('companies', '1:1'), 'display_name', 'Autre nom')
    const rail = screen.getByRole('navigation', { name: 'Tables' })

    await userEvent.click(within(rail).getByRole('link', { name: /^prospects/ }))
    const warning = screen.getByRole('dialog', { name: 'Modifications non enregistrées' })
    expect(warning).toHaveTextContent('1 modification en attente sur companies')
    await userEvent.click(within(warning).getByRole('button', { name: 'Rester sur companies' }))
    expect(screen.getByRole('grid', { name: 'Lignes de companies' })).toBeInTheDocument()
    expect(pendingBar()).toBeInTheDocument()

    await userEvent.click(within(rail).getByRole('link', { name: /^prospects/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Quitter sans enregistrer' }))
    expect(await screen.findByRole('grid', { name: 'Lignes de prospects' })).toBeInTheDocument()
  })

  it('stages a deletion after showing what it cascades to', async () => {
    const fetchMock = stubExplorer()
    renderApp('/database/companies')
    const cell = await cellOf('companies', '0:1')

    await userEvent.pointer({ keys: '[MouseRight]', target: cell })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Supprimer la ligne…' }))
    const dialog = screen.getByRole('dialog', { name: 'Supprimer cette ligne de companies ?' })
    expect(await within(dialog).findByText('Supprime aussi 1 ligne de establishments (Établissements).')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer avec les lignes liées' }))

    expect(cell.closest('tr')).toHaveAttribute('data-status', 'deleted')
    expect(within(pendingBar()).getByText('1 suppression')).toBeInTheDocument()
    const check = fetchMock.mock.calls.map(([input]) => input).find((url) => url.includes('/delete-check?'))
    expect(new URL(check ?? '', 'http://localhost').searchParams.getAll('key')).toEqual([JSON.stringify({ id: COMPANY_IDS[0] })])
  })

  it('selects several rows where bulk deletion is safe and checks them together', async () => {
    const fetchMock = stubExplorer({ [`GET ${API}/companies`]: [200, { ...companiesTable, bulk_delete: true }] })
    renderApp('/database/companies')
    const grid = await screen.findByRole('grid', { name: 'Lignes de companies' })

    await userEvent.click(await within(grid).findByRole('checkbox', { name: 'Sélectionner la ligne 1' }))
    await userEvent.click(within(grid).getByRole('checkbox', { name: 'Sélectionner la ligne 2' }))
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer (2)' }))

    expect(screen.getByRole('dialog', { name: 'Supprimer 2 lignes de companies ?' })).toBeInTheDocument()
    await waitFor(() => {
      const check = fetchMock.mock.calls.map(([input]) => input).find((url) => url.includes('/delete-check?'))
      expect(new URL(check ?? '', 'http://localhost').searchParams.getAll('key')).toHaveLength(2)
    })
  })

  it('keeps the confirmation disabled when the server reports a blocker', async () => {
    const blocked: DeleteCheck = { rows: 1, allowed: false, blockers: ['1 ligne(s) de prospects y font référence : suppression bloquée.'], effects: [] }
    stubExplorer({ [`GET ${API}/companies/delete-check`]: [200, blocked] })
    renderApp('/database/companies')

    await userEvent.pointer({ keys: '[MouseRight]', target: await cellOf('companies', '1:1') })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Supprimer la ligne…' }))

    const dialog = screen.getByRole('dialog', { name: 'Supprimer cette ligne de companies ?' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('suppression bloquée')
    expect(within(dialog).getByRole('button', { name: 'Marquer pour suppression' })).toBeDisabled()
  })

  it('says why a cell is read-only instead of editing it', async () => {
    stubExplorer()
    renderApp('/database/prospects')
    const cell = await cellOf('prospects', '0:4')

    cell.focus()
    await userEvent.keyboard('{F2}')

    expect(within(cell).queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('Lecture seule : Valeur structurée (JSON ou liste) : lecture seule.')).toBeInTheDocument()
    expect(cell).toHaveAttribute('title', 'Lecture seule : Valeur structurée (JSON ou liste) : lecture seule.')
    expect(screen.queryByRole('button', { name: 'Ajouter une ligne' })).not.toBeInTheDocument()
  })

  it('adds a row and opens its first required column', async () => {
    stubExplorer()
    renderApp('/database/companies')
    await screen.findByRole('grid', { name: 'Lignes de companies' })

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter une ligne' }))
    const input = await screen.findByRole('textbox', { name: 'Nouvelle valeur de display_name' })
    await userEvent.type(input, 'Messagerie Démo SA{Enter}')

    expect(within(pendingBar()).getByText('1 ligne ajoutée')).toBeInTheDocument()
    expect(screen.getAllByRole('rowheader')[0]).toHaveTextContent('Nouvelle ligne')
  })

  it('opens a company row in the Company editor and reloads the grid after saving', async () => {
    const companies = stubCompaniesApi({ companies: [company('Logistique Démo SAS', { id: String(COMPANY_IDS[1]) })] })
    const companiesFetch = globalThis.fetch
    const explorerFetch = stubExplorer()
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      new URL(input, 'http://localhost').pathname.startsWith('/api/companies')
        ? companiesFetch(input, init)
        : explorerFetch(input, init),
    )
    renderApp('/database/companies')
    const cell = await cellOf('companies', '1:1')
    const rowLoads = () => explorerFetch.mock.calls.filter(([input]) => input.startsWith(`${API}/companies/rows`)).length
    const loadsBefore = rowLoads()

    await userEvent.pointer({ keys: '[MouseRight]', target: cell })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Ouvrir dans l’éditeur' }))
    const editor = await screen.findByRole('dialog', { name: 'Logistique Démo SAS' })
    await userEvent.type(within(editor).getByRole('textbox', { name: 'Taille' }), '10-49')
    await userEvent.click(within(editor).getByRole('button', { name: 'Enregistrer' }))

    expect(await screen.findByText('Entreprise enregistrée.')).toBeInTheDocument()
    expect(companies.requests.some((request) => request.method === 'PUT')).toBe(true)
    await waitFor(() => {
      expect(rowLoads()).toBeGreaterThan(loadsBefore)
    })
  })

  it('picks a foreign-key target by its label', async () => {
    stubExplorer()
    renderApp('/database/prospects')
    const cell = await cellOf('prospects', '0:1')

    await userEvent.dblClick(cell)
    expect(within(cell).getByRole('combobox', { name: 'Nouvelle valeur de company_id (ligne de companies)' })).toHaveFocus()
    const options = await screen.findByRole('listbox', { name: 'Lignes de companies' })
    await userEvent.click(await within(options).findByRole('option', { name: /Transports Exemple SARL/ }))

    expect(cell).toHaveAttribute('data-dirty')
    expect(cell).toHaveTextContent(String(COMPANY_IDS[0]).slice(-8))
  })
})
