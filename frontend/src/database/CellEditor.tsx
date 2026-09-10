import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { type ExplorerColumn, type RowValues, useExplorerRecord, useExplorerRows, useExplorerTable } from '../api/explorer'
import { AlertIcon } from '../ui/icons'
import { clipboardValue, compactUuid } from './cells'
import { editorText, parseInput } from './editing'

// After a commit: Tab / Shift+Tab move to the next / previous cell, Enter stays (0); null = the focus left the cell.
export type EditorMove = -1 | 0 | 1 | null

interface CellEditorProps {
  table: string
  column: ExplorerColumn
  // Current (possibly staged) value of the cell.
  value: unknown
  // Set when the page holds a truncated preview: the full value is loaded before editing.
  recordKey: RowValues | null
  // A character typed on the cell replaces its content.
  initialText?: string
  onCommit: (value: unknown, move: EditorMove) => void
  // `refocus`: give the focus back to the cell (Esc), not when the focus already moved elsewhere.
  onCancel: (refocus: boolean) => void
}

// Inline, typed cell editor: Enter commits, Tab commits and moves, Esc cancels, leaving the cell commits a valid value.
export function CellEditor({ table, column, value, recordKey, initialText, onCommit, onCancel }: CellEditorProps) {
  const record = useExplorerRecord(table, recordKey ?? {}, recordKey !== null)
  if (recordKey !== null && !record.isSuccess) {
    return (
      <div className="cell-editor">
        <input
          className="cell-editor__input"
          aria-label={`Nouvelle valeur de ${column.name}`}
          disabled
          readOnly
          value={record.isError ? 'Valeur indisponible' : 'Chargement…'}
        />
      </div>
    )
  }
  const current = recordKey !== null ? record.data?.values[column.name] : value
  const text = initialText ?? editorText(column, current)
  const props = { column, initialText: text, onCommit, onCancel }
  if (column.foreign_key) return <ForeignKeyEditor {...props} target={column.foreign_key} />
  return <ValueEditor {...props} original={current} />
}

interface EditorProps {
  column: ExplorerColumn
  initialText: string
  onCommit: (value: unknown, move: EditorMove) => void
  onCancel: (refocus: boolean) => void
}

// Shared lifecycle: `commit(move)` returns false (and shows why) when the text is not a valid value. The control
// takes the focus in an effect, i.e. after a closing context menu has given the focus back to the cell.
function useEditor({ onCommit, onCancel }: Pick<EditorProps, 'onCommit' | 'onCancel'>) {
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)
  const control = useRef<HTMLElement | null>(null)
  useEffect(() => {
    control.current?.focus()
  }, [])
  return {
    error,
    setError,
    controlRef: (element: HTMLElement | null) => {
      control.current = element
    },
    finish: (result: unknown, move: EditorMove) => {
      done.current = true
      onCommit(result, move)
    },
    keys: (commit: (move: EditorMove) => boolean, multiline = false) => {
      return (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          done.current = true
          onCancel(true)
        } else if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
          event.preventDefault()
          commit(0)
        } else if (event.key === 'Tab' && commit(event.shiftKey ? -1 : 1)) {
          event.preventDefault()
        }
      }
    },
    // Leaving the cell keeps a valid value and drops an invalid one.
    blur: (commit: (move: EditorMove) => boolean) => {
      return () => {
        if (!done.current && !commit(null)) {
          done.current = true
          onCancel(false)
        }
      }
    },
  }
}

function caretAtEnd(event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  const { target } = event
  if (target instanceof HTMLTextAreaElement || target.type === 'text') {
    target.setSelectionRange(target.value.length, target.value.length)
  }
}

function ValueEditor({ column, original, initialText, onCommit, onCancel }: EditorProps & { original: unknown }) {
  const [text, setText] = useState(initialText)
  const editor = useEditor({ onCommit, onCancel })
  const choice = column.kind === 'boolean' || column.kind === 'enum'
  const multiline = column.kind === 'text' && column.sql_type === 'text'

  function commit(move: EditorMove, raw = text): boolean {
    const parsed = parseInput(column, raw, original)
    if (!parsed.ok) {
      editor.setError(parsed.message)
      return false
    }
    editor.finish(parsed.value, move)
    return true
  }

  const common = {
    ref: editor.controlRef,
    className: 'cell-editor__input',
    'aria-label': `Nouvelle valeur de ${column.name}`,
    'aria-invalid': editor.error ? true : undefined,
    onKeyDown: editor.keys(commit, multiline),
    onBlur: editor.blur(commit),
  }
  const edited = (next: string) => {
    setText(next)
    editor.setError(null)
  }

  let control
  if (choice) {
    const options = column.kind === 'boolean' ? ['true', 'false'] : (column.allowed_values ?? [])
    control = (
      <select
        {...common}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          commit(0, event.target.value)
        }}
      >
        {(column.nullable || text === '') && <option value="">{column.nullable ? 'NULL' : '— choisir —'}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {column.kind === 'boolean' ? (option === 'true' ? 'true (vrai)' : 'false (faux)') : option}
          </option>
        ))}
      </select>
    )
  } else if (multiline) {
    control = (
      <textarea
        {...common}
        className="cell-editor__input cell-editor__input--multiline"
        value={text}
        rows={4}
        onFocus={caretAtEnd}
        onChange={(event) => {
          edited(event.target.value)
        }}
      />
    )
  } else {
    const type = column.kind === 'datetime' ? 'datetime-local' : column.kind === 'date' ? 'date' : 'text'
    control = (
      <input
        {...common}
        type={type}
        step={type === 'datetime-local' ? 1 : undefined}
        inputMode={column.kind === 'integer' || column.kind === 'number' ? 'decimal' : undefined}
        value={text}
        onFocus={caretAtEnd}
        onChange={(event) => {
          edited(event.target.value)
        }}
      />
    )
  }

  return (
    <div className="cell-editor" data-multiline={multiline ? '' : undefined}>
      {control}
      {column.nullable && !choice && (
        <NullButton
          onClick={() => {
            editor.finish(null, 0)
          }}
        />
      )}
      {editor.error && <EditorError message={editor.error} />}
    </div>
  )
}

function NullButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="cell-editor__null"
      title="Enregistrer NULL (aucune valeur)"
      onMouseDown={(event) => {
        // Keep the focus in the editor: its blur would commit the typed text first.
        event.preventDefault()
      }}
      onClick={onClick}
    >
      NULL
    </button>
  )
}

function EditorError({ message }: { message: string }) {
  return (
    <span className="cell-editor__error" role="alert">
      <AlertIcon size={14} />
      {message}
    </span>
  )
}

const LOOKUP_DELAY_MS = 250
const LOOKUP_SIZE = 8

interface ForeignKeyEditorProps extends EditorProps {
  target: { table: string; column: string }
}

// Foreign key: paste an identifier, or search the referenced table (its label columns are shown) and pick a row.
function ForeignKeyEditor({ column, target, initialText, onCommit, onCancel }: ForeignKeyEditorProps) {
  const [text, setText] = useState(initialText)
  const [search, setSearch] = useState(initialText)
  const [active, setActive] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const editor = useEditor({ onCommit, onCancel })
  const targetMeta = useExplorerTable(target.table)
  const results = useExplorerRows(
    target.table,
    { filter: null, search: search.trim(), sort: [], offset: 0, limit: LOOKUP_SIZE },
    targetMeta.isSuccess,
  )
  const labels = targetMeta.data?.label_columns ?? []
  const options = (results.data?.rows ?? []).map((row) => ({
    id: String(row.values[target.column]),
    label: labels
      .map((name) => clipboardValue(row.values[name]))
      .filter(Boolean)
      .join(' '),
  }))

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(text)
    }, LOOKUP_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [text])

  // Enter picks the highlighted row when the user moved through the list or typed a search; a pasted identifier is
  // kept as is (the server checks it exists).
  function commit(move: EditorMove): boolean {
    const parsed = parseInput(column, text.trim(), undefined)
    const picked = (navigated || !parsed.ok) && search === text ? options[active] : undefined
    if (picked) {
      editor.finish(picked.id, move)
      return true
    }
    if (!parsed.ok) {
      editor.setError(`Choisissez une ligne de ${target.table} ou collez son identifiant.`)
      return false
    }
    editor.finish(parsed.value, move)
    return true
  }

  const keys = editor.keys(commit)
  const listId = `fk-options-${column.name}`

  return (
    <div className="cell-editor">
      <input
        ref={(element) => {
          editor.controlRef(element)
          if (element && !anchor) setAnchor(element.getBoundingClientRect())
        }}
        className="cell-editor__input"
        role="combobox"
        aria-expanded={anchor !== null}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options[active] ? `${listId}-${String(active)}` : undefined}
        aria-label={`Nouvelle valeur de ${column.name} (ligne de ${target.table})`}
        aria-invalid={editor.error ? true : undefined}
        value={text}
        onFocus={caretAtEnd}
        onChange={(event) => {
          setText(event.target.value)
          setActive(0)
          setNavigated(false)
          editor.setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            setNavigated(true)
            setActive((index) => (options.length ? (index + step + options.length) % options.length : 0))
            return
          }
          keys(event)
        }}
        onBlur={editor.blur(commit)}
      />
      {column.nullable && (
        <NullButton
          onClick={() => {
            editor.finish(null, 0)
          }}
        />
      )}
      {editor.error && <EditorError message={editor.error} />}
      {anchor &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            aria-label={`Lignes de ${target.table}`}
            className="fk-options"
            style={{ left: anchor.left, top: anchor.bottom + 4, minWidth: Math.max(anchor.width, 288) }}
          >
            {results.isPending && <li className="fk-options__note">Recherche…</li>}
            {results.isSuccess && options.length === 0 && (
              <li className="fk-options__note">Aucune ligne de {target.table} ne correspond.</li>
            )}
            {options.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={index === active}
                className="fk-options__item"
                onMouseDown={(event) => {
                  event.preventDefault()
                  editor.finish(option.id, 0)
                }}
              >
                <span className="fk-options__label">{option.label || target.table}</span>
                <span className="fk-options__id">{compactUuid(option.id)}</span>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  )
}
