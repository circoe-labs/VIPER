import { describe, expect, it, vi } from 'vitest'

import {
  COMPANY_IDS,
  companiesTable,
  companyRows,
  PROSPECT_ID,
  prospectRows,
  prospectsTable,
} from '../test/explorerFixtures'
import type { MenuItem } from '../ui/Menu'
import { buildCellMenu, type CellEffects } from './cellMenu'
import { parseView } from './explorerView'
import { readOrigin, referencedRowHref, referencingRowsHref } from './navigation'

function effects(): CellEffects {
  return { copy: vi.fn(), addFilter: vi.fn(), navigate: vi.fn(), viewValue: vi.fn() }
}

function items(sections: ReturnType<typeof buildCellMenu>): Record<string, MenuItem> {
  return Object.fromEntries(sections.flatMap((section) => section.items).map((item) => [item.id, item]))
}

const companyColumns = companiesTable.columns.map((column) => column.name)
const [idColumn, , sizeLabel, clientApproach] = companiesTable.columns
const companyId = prospectsTable.columns[1]

function hrefTarget(href: string) {
  const url = new URL(href, 'http://localhost')
  return { path: url.pathname, view: parseView(url.searchParams) }
}

describe('relationship links', () => {
  it('opens the referenced row through a primary-key filter', () => {
    if (!companyId) throw new Error('fixture')
    const href = referencedRowHref(companyId, COMPANY_IDS[1])

    expect(hrefTarget(href ?? '')).toMatchObject({
      path: '/database/companies',
      view: { filters: [{ column: 'id', operator: 'eq', value: COMPANY_IDS[1] }] },
    })
    expect(referencedRowHref(companyId, null)).toBeNull()
    expect(referencedRowHref(idColumn ?? companyId, COMPANY_IDS[0])).toBeNull()
  })

  it('lists the rows of another table pointing at this one', () => {
    const reference = companiesTable.referenced_by[0]
    if (!reference) throw new Error('fixture')

    expect(hrefTarget(referencingRowsHref(reference, { id: COMPANY_IDS[0] }) ?? '')).toMatchObject({
      path: '/database/prospects',
      view: { filters: [{ column: 'company_id', operator: 'eq', value: COMPANY_IDS[0] }] },
    })
  })

  it('reads the navigation origin from history state defensively', () => {
    expect(readOrigin({ origin: { table: 'prospects' } })).toEqual({ table: 'prospects' })
    expect(readOrigin(null)).toBeNull()
    expect(readOrigin({ origin: 'x' })).toBeNull()
  })
})

describe('buildCellMenu', () => {
  it('offers copy, filter and FK actions on a foreign-key cell', () => {
    const row = prospectRows[0]
    if (!row || !companyId) throw new Error('fixture')
    const fx = effects()
    const menu = items(
      buildCellMenu({ column: companyId, row, columns: ['id', 'company_id'], referencedBy: [] }, fx),
    )

    expect(Object.keys(menu)).toEqual(['copy-cell', 'view-value', 'copy-row-tsv', 'copy-row-json', 'filter-value', 'exclude-value', 'open-reference'])
    menu['copy-cell']?.onSelect()
    expect(fx.copy).toHaveBeenCalledWith(COMPANY_IDS[1], 'Valeur copiée')
    menu['copy-row-tsv']?.onSelect()
    expect(fx.copy).toHaveBeenLastCalledWith(`${PROSPECT_ID}\t${String(COMPANY_IDS[1])}`, 'Ligne copiée (TSV)')
    menu['filter-value']?.onSelect()
    expect(fx.addFilter).toHaveBeenCalledWith({ column: 'company_id', operator: 'eq', value: COMPANY_IDS[1] })
    menu['open-reference']?.onSelect()
    expect(fx.navigate).toHaveBeenCalledWith(referencedRowHref(companyId, COMPANY_IDS[1]))
    expect(menu['open-reference']?.hint).toBe('companies')
  })

  it('filters on NULL and links to referencing rows', () => {
    const row = companyRows[0]
    if (!row || !sizeLabel) throw new Error('fixture')
    const menu = items(
      buildCellMenu({ column: sizeLabel, row, columns: companyColumns, referencedBy: companiesTable.referenced_by }, effects()),
    )

    expect(menu['filter-value']?.label).toBe('Filtrer sur les valeurs vides')
    expect(menu['exclude-value']?.label).toBe('Exclure les valeurs vides')
    expect(menu['referencing-prospects-company_id']?.label).toBe('Lignes liées : prospects')
    expect(menu['open-reference']).toBeUndefined()
  })

  it('never filters on a truncated preview and says the copy is partial', () => {
    const row = companyRows[0]
    if (!row || !clientApproach) throw new Error('fixture')
    const fx = effects()
    const menu = items(buildCellMenu({ column: clientApproach, row, columns: companyColumns, referencedBy: [] }, fx))

    expect(menu['filter-value']).toBeUndefined()
    expect(menu['exclude-value']).toBeUndefined()
    expect(menu['copy-cell']?.label).toBe('Copier l’aperçu tronqué')
    menu['view-value']?.onSelect()
    expect(fx.viewValue).toHaveBeenCalled()
  })
})
