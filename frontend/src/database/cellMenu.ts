// Actions offered on a grid cell (right-click, Shift+F10 or the context-menu key). Pure: the grid supplies the
// effects, so the rules — which action appears when — are unit-tested.
import type { ExplorerColumn, ExplorerReference, ExplorerRow } from '../api/explorer'
import type { MenuItem, MenuSection } from '../ui/Menu'
import {
  BuildingIcon,
  CopyIcon,
  ExpandIcon,
  FilterIcon,
  LinkIcon,
  LockIcon,
  MinusCircleIcon,
  PencilIcon,
  TrashIcon,
  UndoIcon,
} from '../ui/icons'
import { clipboardValue, rowToJson, rowToTsv } from './cells'
import type { Editability } from './editing'
import type { ColumnFilter } from './explorerView'
import { filterForValue } from './filters'
import { referencedRowHref, referencingRowsHref } from './navigation'
import type { RowStatus } from './staging'

export interface CellContext {
  column: ExplorerColumn
  row: ExplorerRow
  // Displayed columns, in display order (row copies follow what the user sees).
  columns: string[]
  referencedBy: ExplorerReference[]
  editing: CellEditingContext
}

// What the staged-editing layer allows on this cell and its row.
export interface CellEditingContext {
  editability: Editability
  // The cell holds a staged (unsaved) value.
  dirty: boolean
  status: RowStatus
  // Rows can be deleted from this table; `selectedCount` rows are selected (the clicked one included).
  canDelete: boolean
  selectedCount: number
}

export interface CellEffects {
  copy: (text: string, message: string) => void
  addFilter: (filter: ColumnFilter) => void
  navigate: (href: string) => void
  viewValue: () => void
  edit: () => void
  setNull: () => void
  revertCell: () => void
  deleteRows: () => void
  restoreRow: () => void
  // The row has a dedicated editor (e.g. companies → the Company editor, Task 07).
  openEditor?: () => void
}

function editItems(column: ExplorerColumn, value: unknown, editing: CellEditingContext, effects: CellEffects): MenuItem[] {
  const { editability } = editing
  const items: MenuItem[] = editability.editable
    ? [{ id: 'edit-cell', label: 'Modifier la cellule', icon: PencilIcon, hint: 'F2', onSelect: effects.edit }]
    : [
        {
          id: 'read-only',
          label: `Lecture seule : ${editability.reason}`,
          title: editability.reason,
          icon: LockIcon,
          disabled: true,
          onSelect: () => undefined,
        },
      ]
  if (editability.editable && column.nullable && value !== null) {
    items.push({ id: 'set-null', label: 'Mettre à NULL', icon: MinusCircleIcon, onSelect: effects.setNull })
  }
  if (editing.dirty) {
    items.push({ id: 'revert-cell', label: 'Annuler la modification', icon: UndoIcon, onSelect: effects.revertCell })
  }
  return items
}

function rowEditItems({ status, canDelete, selectedCount }: CellEditingContext, effects: CellEffects): MenuItem[] {
  if (status === 'new') {
    return [{ id: 'remove-new', label: 'Retirer la nouvelle ligne', icon: TrashIcon, onSelect: effects.restoreRow }]
  }
  if (status === 'deleted') {
    return [{ id: 'restore-row', label: 'Annuler la suppression', icon: UndoIcon, onSelect: effects.restoreRow }]
  }
  if (!canDelete) return []
  const label = selectedCount > 1 ? `Supprimer les ${String(selectedCount)} lignes sélectionnées…` : 'Supprimer la ligne…'
  return [{ id: 'delete-rows', label, icon: TrashIcon, danger: true, onSelect: effects.deleteRows }]
}

export function buildCellMenu({ column, row, columns, referencedBy, editing }: CellContext, effects: CellEffects): MenuSection[] {
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
    { label: 'Cellule', items: [...cell, ...editItems(column, value, editing, effects)] },
    {
      label: 'Ligne',
      items: [
        ...(effects.openEditor
          ? [{ id: 'open-editor', label: 'Ouvrir dans l’éditeur', icon: BuildingIcon, onSelect: effects.openEditor }]
          : []),
        ...rowItems,
        ...rowEditItems(editing, effects),
      ],
    },
    { label: 'Filtre', items: filters },
    { label: 'Relations', items: links },
  ].filter((section) => section.items.length > 0)
}

