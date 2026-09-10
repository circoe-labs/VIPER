import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import {
  COMPANY_IDS,
  companiesTable,
  companyRows,
  LONG_TEXT,
  page,
  prospectRows,
  prospectsTable,
  TABLES,
} from '../test/explorerFixtures'
import { renderApp, stubApi } from '../test/render'

const API = '/api/explorer/tables'

function stubExplorer() {
  return stubApi({
    'GET /api/health': [200, { status: 'ok', database: 'ok' }],
    [`GET ${API}`]: [200, TABLES],
    [`GET ${API}/companies`]: [200, companiesTable],
    [`GET ${API}/prospects`]: [200, prospectsTable],
    [`GET ${API}/companies/rows`]: (url) => {
      const filter = url.searchParams.get('filter')
      return [200, page(filter?.includes(String(COMPANY_IDS[1])) ? companyRows.slice(1) : companyRows)]
    },
    [`GET ${API}/prospects/rows`]: [200, page(prospectRows)],
    [`GET ${API}/companies/record`]: (url) =>
      url.searchParams.get('key')?.includes(String(COMPANY_IDS[0]))
        ? [200, { values: { ...companyRows[0]?.values, client_approach: LONG_TEXT } }]
        : [404, { detail: 'missing' }],
  })
}

// URLs of the row requests made so far, for a table.
function rowRequests(fetchMock: Mock, table: string): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === `${API}/${table}/rows`)
}

function lastRowRequest(fetchMock: Mock, table: string): URL {
  const url = rowRequests(fetchMock, table).at(-1)
  if (!url) throw new Error(`no row request for ${table}`)
  return url
}

async function openTable(name: string) {
  await userEvent.click(await screen.findByRole('link', { name: new RegExp(`^${name}`) }))
  return screen.findByRole('grid', { name: `Lignes de ${name}` })
}

describe('Database page', () => {
  // jsdom has no layout: give elements a size so the row virtualizer renders the visible rows.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
  })

  it('lists the exposed tables by group with French labels and row counts', async () => {
    stubExplorer()
    renderApp('/database')

    const rail = screen.getByRole('navigation', { name: 'Tables' })
    const companies = await within(rail).findByRole('link', { name: /^companies/ })
    expect(companies).toHaveTextContent('Entreprises')
    expect(companies).toHaveTextContent('2 lignes')
    expect(within(rail).getByRole('region', { name: 'Référentiels' })).toHaveTextContent('roles')
    expect(screen.getByRole('heading', { name: 'Choisissez une table' })).toBeInTheDocument()

    await userEvent.type(within(rail).getByRole('searchbox', { name: 'Filtrer les tables' }), 'ENTREPRISE')
    expect(within(rail).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/database/companies'])
  })

  it('opens a table in the grid with sticky context and paging information', async () => {
    stubExplorer()
    renderApp('/database')

    const grid = await openTable('companies')

    expect(screen.getByRole('heading', { level: 2, name: 'companies' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Tables' })).getByRole('link', { name: /^companies/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(await within(grid).findByText('Transports Exemple SARL')).toBeInTheDocument()
    expect(within(grid).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['1', '2'])
    expect(within(grid).getAllByText('NULL')).not.toHaveLength(0)
    expect(screen.getByText('Lignes 1–2 sur 2')).toBeInTheDocument()
  })

  it('sorts on header click and adds sort keys with Shift', async () => {
    const fetchMock = stubExplorer()
    renderApp('/database/companies')
    const grid = await screen.findByRole('grid', { name: 'Lignes de companies' })

    await userEvent.click(within(grid).getByRole('button', { name: 'display_name, non trié' }))
    await waitFor(() => {
      expect(lastRowRequest(fetchMock, 'companies').searchParams.getAll('sort')).toEqual(['display_name'])
    })
    const user = userEvent.setup()
    await user.keyboard('{Shift>}')
    await user.click(within(grid).getByRole('button', { name: 'size_label, non trié' }))
    await user.keyboard('{/Shift}')

    await waitFor(() => {
      expect(lastRowRequest(fetchMock, 'companies').searchParams.getAll('sort')).toEqual(['display_name', 'size_label'])
    })
    const sorted = within(grid).getByRole('button', { name: 'size_label, tri croissant (priorité 2)' })
    expect(sorted.closest('th')).toHaveAttribute('aria-sort', 'ascending')
  })

  it('filters by a cell value from the keyboard context menu', async () => {
    const fetchMock = stubExplorer()
    renderApp('/database/companies')
    const grid = await screen.findByRole('grid', { name: 'Lignes de companies' })
    const nullCell = (await within(grid).findAllByRole('gridcell')).find((cell) => cell.dataset.cell === '0:2')
    if (!nullCell) throw new Error('size_label cell not rendered')

    nullCell.focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    const menu = screen.getByRole('menu', { name: 'Actions sur size_label' })
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus()
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Filtrer sur les valeurs vides' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Critères actifs' })).toHaveTextContent('size_label est vide (NULL)')
    await waitFor(() => {
      expect(JSON.parse(lastRowRequest(fetchMock, 'companies').searchParams.get('filter') ?? 'null')).toEqual({
        type: 'group',
        combinator: 'and',
        conditions: [{ type: 'condition', column: 'size_label', operator: 'is_null' }],
      })
    })

    await userEvent.click(screen.getByRole('button', { name: 'Effacer les filtres' }))
    expect(screen.queryByRole('group', { name: 'Critères actifs' })).not.toBeInTheDocument()
  })

  it('navigates to the referenced row and back', async () => {
    const fetchMock = stubExplorer()
    renderApp('/database/prospects')
    const grid = await screen.findByRole('grid', { name: 'Lignes de prospects' })
    const fkCell = (await within(grid).findAllByRole('gridcell')).find((cell) => cell.dataset.cell === '0:1')
    if (!fkCell) throw new Error('company_id cell not rendered')

    await userEvent.pointer({ keys: '[MouseRight]', target: fkCell })
    await userEvent.click(screen.getByRole('menuitem', { name: /Ouvrir la ligne référencée/ }))

    const companies = await screen.findByRole('grid', { name: 'Lignes de companies' })
    expect(await within(companies).findByText('Logistique Démo SAS')).toBeInTheDocument()
    expect(within(companies).queryByText('Transports Exemple SARL')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Critères actifs' })).toHaveTextContent(`id est égal à « ${String(COMPANY_IDS[1])} »`)
    expect(lastRowRequest(fetchMock, 'companies').searchParams.get('filter')).toContain(String(COMPANY_IDS[1]))

    await userEvent.click(screen.getByRole('button', { name: 'Retour à prospects' }))
    expect(await screen.findByRole('grid', { name: 'Lignes de prospects' })).toBeInTheDocument()
  })

  it('shows the complete value of a truncated cell', async () => {
    stubExplorer()
    renderApp('/database/companies')
    const grid = await screen.findByRole('grid', { name: 'Lignes de companies' })
    const cell = (await within(grid).findAllByRole('gridcell')).find((item) => item.dataset.cell === '0:3')
    if (!cell) throw new Error('client_approach cell not rendered')

    // Double-click edits an editable cell: the expand button opens the viewer.
    await userEvent.click(within(cell).getByRole('button', { name: 'Voir la valeur complète' }))

    const viewer = screen.getByRole('dialog', { name: 'client_approach' })
    expect(await within(viewer).findByLabelText('Valeur de client_approach')).toHaveTextContent(LONG_TEXT.trim())
    expect(within(viewer).getByText(`${String(LONG_TEXT.length)} caractères`)).toBeInTheDocument()
  })

  it('copies a cell with Ctrl+C and announces it', async () => {
    const user = userEvent.setup()
    stubExplorer()
    renderApp('/database/companies')
    const grid = await screen.findByRole('grid', { name: 'Lignes de companies' })
    const cell = (await within(grid).findAllByRole('gridcell')).find((item) => item.dataset.cell === '1:1')
    if (!cell) throw new Error('display_name cell not rendered')

    await user.click(cell)
    await user.keyboard('{Control>}c{/Control}')

    expect(await navigator.clipboard.readText()).toBe('Logistique Démo SAS')
    expect(await screen.findByText('Valeur copiée')).toBeInTheDocument()
  })

  it('hides a column from its menu and remembers the layout per table', async () => {
    stubExplorer()
    const { unmount } = renderApp('/database/companies')
    const grid = await screen.findByRole('grid', { name: 'Lignes de companies' })

    await userEvent.click(within(grid).getByRole('button', { name: 'Options de la colonne size_label' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Masquer la colonne' }))

    expect(within(grid).queryByRole('button', { name: /^size_label,/ })).not.toBeInTheDocument()
    unmount()
    renderApp('/database/companies')
    const again = await screen.findByRole('grid', { name: 'Lignes de companies' })
    expect(within(again).getByRole('button', { name: /^display_name,/ })).toBeInTheDocument()
    expect(within(again).queryByRole('button', { name: /^size_label,/ })).not.toBeInTheDocument()
  })

  it('explains an unknown or hidden table', async () => {
    stubExplorer()
    renderApp('/database/alembic_version')

    expect(await screen.findByRole('heading', { name: 'Table introuvable' })).toBeInTheDocument()
  })
})
