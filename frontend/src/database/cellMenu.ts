// Actions offered on a grid cell (right-click, Shift+F10 or the context-menu key). Pure: the grid supplies the
// effects, so the rules — which action appears when — are unit-tested.
import type { ExplorerColumn, ExplorerReference, ExplorerRow } from '../api/explorer'
import type { MenuItem, MenuSection } from '../ui/Menu'
import { CopyIcon, ExpandIcon, FilterIcon, LinkIcon, MinusCircleIcon } from '../ui/icons'
import { clipboardValue, rowToJson, rowToTsv } from './cells'
import type { ColumnFilter } from './explorerView'
import { filterForValue } from './filters'
import { referencedRowHref, referencingRowsHref } from './navigation'

export interface CellContext {
  column: ExplorerColumn
  row: ExplorerRow
  // Displayed columns, in display order (row copies follow what the user sees).
  columns: string[]
  referencedBy: ExplorerReference[]
}

export interface CellEffects {
  copy: (text: string, message: string) => void
  addFilter: (filter: ColumnFilter) => void
  navigate: (href: string) => void
  viewValue: () => void
}

export function buildCellMenu({ column, row, columns, referencedBy }: CellContext, effects: CellEffects): MenuSection[] {
  const value = row.values[column.name]
  const truncated = row.truncated.includes(column.name)
  // A truncated preview is not the stored value: it cannot be copied or filtered on as such.
  const include = truncated ? null : filterForValue(column, value)
  const exclude = truncated ? null : filterForValue(column, value, true)
  const target = referencedRowHref(column, value)

  const cell: MenuItem[] = [
    {
      id: 'copy-cell',
      label: truncated ? 'Copier l’aperçu tronqué' : 'Copier la valeur',
      icon: CopyIcon,
      hint: 'Ctrl+C',
      disabled: column.masked,
      onSelect: () => {
        effects.copy(clipboardValue(value), 'Valeur copiée')
      },
    },
    {
      id: 'view-value',
      label: 'Voir la valeur complète',
      icon: ExpandIcon,
      hint: 'Entrée',
      disabled: column.masked,
      onSelect: effects.viewValue,
    },
  ]
  const rowItems: MenuItem[] = [
    {
      id: 'copy-row-tsv',
      label: 'Copier la ligne (TSV)',
      icon: CopyIcon,
      onSelect: () => {
        effects.copy(rowToTsv(row.values, columns), 'Ligne copiée (TSV)')
      },
    },
    {
      id: 'copy-row-json',
      label: 'Copier la ligne (JSON)',
      icon: CopyIcon,
      onSelect: () => {
        effects.copy(rowToJson(row.values, columns), 'Ligne copiée (JSON)')
      },
    },
  ]
  const filters: MenuItem[] = []
  if (include) {
    filters.push(
      {
        id: 'filter-value',
        label: value === null ? 'Filtrer sur les valeurs vides' : 'Filtrer sur cette valeur',
        icon: FilterIcon,
        onSelect: () => {
          effects.addFilter(include)
        },
      },
    )
  }
  if (exclude) {
    filters.push(
      {
        id: 'exclude-value',
        label: value === null ? 'Exclure les valeurs vides' : 'Exclure cette valeur',
        icon: MinusCircleIcon,
        onSelect: () => {
          effects.addFilter(exclude)
        },
      },
    )
  }
  const links: MenuItem[] = []
  if (target && column.foreign_key) {
    links.push(
      {
        id: 'open-reference',
        label: 'Ouvrir la ligne référencée',
        icon: LinkIcon,
        hint: column.foreign_key.table,
        onSelect: () => {
          effects.navigate(target)
        },
      },
    )
  }
  for (const reference of referencedBy) {
    const href = referencingRowsHref(reference, row.values)
    if (!href) continue
    links.push(
      {
        id: `referencing-${reference.table}-${reference.column}`,
        label: `Lignes liées : ${reference.table}`,
        icon: LinkIcon,
        hint: reference.column,
        onSelect: () => {
          effects.navigate(href)
        },
      },
    )
  }

  return [
    { label: 'Cellule', items: cell },
    { label: 'Ligne', items: rowItems },
    { label: 'Filtre', items: filters },
    { label: 'Relations', items: links },
  ].filter((section) => section.items.length > 0)
}

