import { type SyntheticEvent, useState } from 'react'

import type { ExplorerColumn, FilterOperator } from '../api/explorer'
import { Button, IconButton } from '../ui/Button'
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/fields'
import { CloseIcon } from '../ui/icons'
import type { ColumnFilter } from './explorerView'
import { buildFilter, describeFilter, needsValue, operatorLabel } from './filters'

interface ColumnFilterEditorProps {
  column: ExplorerColumn
  // Active filters on this column, with their index in the view's filter list.
  active: { filter: ColumnFilter; index: number }[]
  onApply: (filter: ColumnFilter) => void
  onRemove: (index: number) => void
  onCancel: () => void
}

const INPUT_TYPES: Partial<Record<ExplorerColumn['kind'], string>> = {
  integer: 'number',
  number: 'number',
  datetime: 'datetime-local',
  date: 'date',
}

// Popover body: pick a condition valid for the column's kind, type a value, apply. Several filters on one column
// combine with AND (e.g. a date range).
export function ColumnFilterEditor({ column, active, onApply, onRemove, onCancel }: ColumnFilterEditorProps) {
  const [operator, setOperator] = useState<FilterOperator>(column.filter_operators[0] ?? 'is_null')
  const [raw, setRaw] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState<string>()

  const enumChoices = column.kind === 'enum' ? (column.allowed_values ?? []) : []

  function submit(event: SyntheticEvent) {
    event.preventDefault()
    const input = operator === 'in' && enumChoices.length > 0 ? picked.join('\n') : raw
    const result = buildFilter(column, operator, input)
    if (result.ok) onApply(result.filter)
    else setError(result.error)
  }

  function change(value: string) {
    setRaw(value)
    setError(undefined)
  }

  function valueField() {
    if (!needsValue(operator)) return null
    if (operator === 'in' && enumChoices.length > 0) {
      return (
        <fieldset className="filter-editor__choices">
          <legend className="field__label">Valeurs</legend>
          {enumChoices.map((choice) => (
            <Checkbox
              key={choice}
              label={choice}
              checked={picked.includes(choice)}
              onChange={(event) => {
                setPicked(event.target.checked ? [...picked, choice] : picked.filter((item) => item !== choice))
                setError(undefined)
              }}
            />
          ))}
          {error && <p className="field__error">{error}</p>}
        </fieldset>
      )
    }
    if (operator === 'in') {
      return (
        <TextAreaField
          label="Valeurs"
          hint="Une valeur par ligne, ou séparées par des virgules."
          value={raw}
          error={error}
          onChange={(event) => {
            change(event.target.value)
          }}
        />
      )
    }
    if (column.kind === 'enum' || column.kind === 'boolean') {
      const choices = column.kind === 'boolean' ? ['true', 'false'] : enumChoices
      return (
        <SelectField
          label="Valeur"
          value={raw}
          error={error}
          onChange={(event) => {
            change(event.target.value)
          }}
        >
          <option value="">Choisir…</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </SelectField>
      )
    }
    const textual = operator === 'contains' || operator === 'starts_with'
    return (
      <TextField
        label="Valeur"
        type={textual ? 'text' : (INPUT_TYPES[column.kind] ?? 'text')}
        step={column.kind === 'datetime' ? 1 : column.kind === 'number' ? 'any' : undefined}
        value={raw}
        error={error}
        hint={column.kind === 'datetime' ? 'Heure locale de votre navigateur.' : undefined}
        onChange={(event) => {
          change(event.target.value)
        }}
      />
    )
  }

  return (
    <form className="filter-editor" onSubmit={submit} noValidate>
      <div className="filter-editor__heading">
        <p className="filter-editor__title">{column.name}</p>
        <p className="filter-editor__type">{column.sql_type}</p>
      </div>
      {active.length > 0 && (
        <ul className="filter-editor__active" aria-label="Filtres actifs sur cette colonne">
          {active.map(({ filter, index }) => (
            <li key={index}>
              <span>{describeFilter(filter, column).replace(`${column.name} `, '')}</span>
              <IconButton
                icon={CloseIcon}
                size="sm"
                label={`Retirer le filtre : ${describeFilter(filter, column)}`}
                onClick={() => {
                  onRemove(index)
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <SelectField
        label="Condition"
        value={operator}
        onChange={(event) => {
          setOperator(event.target.value as FilterOperator)
          setError(undefined)
        }}
      >
        {column.filter_operators.map((option) => (
          <option key={option} value={option}>
            {operatorLabel(option, column)}
          </option>
        ))}
      </SelectField>
      {valueField()}
      <div className="filter-editor__actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Annuler
        </Button>
        <Button variant="primary" size="sm" type="submit">
          Ajouter le filtre
        </Button>
      </div>
    </form>
  )
}
