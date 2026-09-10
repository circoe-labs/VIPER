import { type FocusEvent, type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'

import { foldText, matchesWords } from '../lib/text'
import { Badge } from './Badge'
import { FieldFrame } from './fields'
import { CheckIcon, ChevronDownIcon, CloseIcon, InfoIcon, PlusIcon, SpinnerIcon } from './icons'
import './combobox.css'

export interface ComboboxOption {
  id: string
  label: string
  // Secondary text under the label (e.g. an e-mail address).
  hint?: string
  // Deactivated value: offered only while selected (a record that already uses it keeps it).
  inactive?: boolean
}

export interface ComboboxCreate {
  // Creates a value from the typed text and resolves to its option, which is then selected. Rejects with an Error
  // whose message is shown under the field.
  run: (text: string) => Promise<ComboboxOption>
  // Text of the creation option (default « Créer « text » »).
  label?: (text: string) => string
  // Why `text` cannot be created as typed (shown instead of the option), or null.
  refuse?: (text: string) => string | null
}

interface BaseProps {
  label: string
  options: readonly ComboboxOption[]
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  disabled?: boolean
  placeholder?: string
  status?: 'ready' | 'loading' | 'error'
  // Inline creation ("Créer « … »") when no option carries the typed text.
  create?: ComboboxCreate
}

export type ComboboxProps =
  | (BaseProps & { multiple?: false; value: string | null; onChange: (value: string | null) => void })
  | (BaseProps & { multiple: true; value: readonly string[]; onChange: (value: string[]) => void })

type Item = { kind: 'option'; option: ComboboxOption } | { kind: 'create'; text: string }

// Searchable single/multi picker (WAI-ARIA combobox + listbox). Typing filters options ignoring case and accents;
// ↓/↑ open and move, Enter picks, Esc closes, Backspace in an empty multi picker removes the last value. Inactive
// values only appear while selected. With `create`, an unmatched text becomes a « Créer « … » » option.
export function Combobox(props: ComboboxProps) {
  const { label, options, hint, error, required, disabled, placeholder, status = 'ready', create } = props
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  // null: not typing — a single picker then shows the selected label.
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const selectedIds: readonly string[] = props.multiple ? props.value : props.value ? [props.value] : []
  const byId = new Map(options.map((option) => [option.id, option]))
  const typed = query?.trim() ?? ''
  const offered = options.filter(
    (option) => (!option.inactive || selectedIds.includes(option.id)) && (!typed || matchesWords(option.label, typed)),
  )
  const same = typed ? options.find((option) => foldText(option.label) === foldText(typed)) : undefined
  const hiddenInactive = same?.inactive && !selectedIds.includes(same.id) ? same : undefined
  const refusal = create && typed && !same ? (create.refuse?.(typed) ?? null) : null
  const items: Item[] = offered.map((option) => ({ kind: 'option', option }))
  if (create && typed && !same && !refusal) items.push({ kind: 'create', text: typed })
  const active = Math.min(activeIndex, items.length - 1)

  const selectedLabel = props.multiple || !props.value ? '' : (byId.get(props.value)?.label ?? '')
  const inputValue = query ?? selectedLabel

  function openList() {
    setOpen(true)
    setActiveIndex(Math.max(0, items.findIndex((item) => item.kind === 'option' && selectedIds.includes(item.option.id))))
  }

  function close() {
    setOpen(false)
    setQuery(null)
    setActiveIndex(0)
  }

  function select(id: string) {
    if (props.multiple) {
      props.onChange(props.value.includes(id) ? props.value.filter((value) => value !== id) : [...props.value, id])
      setQuery('')
    } else {
      props.onChange(id)
      close()
    }
  }

  async function createFrom(text: string) {
    if (!create) return
    setCreating(true)
    setCreateError(null)
    try {
      const option = await create.run(text)
      if (props.multiple) {
        props.onChange([...props.value.filter((value) => value !== option.id), option.id])
        setQuery('')
      } else {
        props.onChange(option.id)
        close()
      }
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : 'Création impossible.')
    } finally {
      setCreating(false)
    }
  }

  function choose(item: Item) {
    if (creating) return
    if (item.kind === 'option') select(item.option.id)
    else void createFrom(item.text)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) {
          openList()
          break
        }
        const step = event.key === 'ArrowDown' ? 1 : -1
        if (items.length > 0) setActiveIndex((active + step + items.length) % items.length)
        break
      }
      case 'Enter': {
        const item = items[active]
        if (open && item) {
          event.preventDefault()
          choose(item)
        }
        break
      }
      case 'Escape':
        if (open) {
          // Handled here: an enclosing dialog must not close too.
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        break
      case 'Backspace':
        if (props.multiple && !query && props.value.length > 0) props.onChange(props.value.slice(0, -1))
        break
      case 'Tab':
        close()
        break
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!rootRef.current?.contains(event.relatedTarget)) close()
  }

  const optionId = (index: number) => `${listId}-${String(index)}`
  const activeItem = open ? items[active] : undefined

  return (
    <FieldFrame label={label} hint={hint} error={createError ?? error} required={required}>
      {(a11y) => (
        <div ref={rootRef} className="combobox" onBlur={handleBlur}>
          <div className="combobox__control" data-disabled={disabled ? '' : undefined}>
            {props.multiple &&
              props.value.map((id) => {
                const option = byId.get(id)
                const text = option?.label ?? '…'
                return (
                  <span key={id} className={`combobox__chip${option?.inactive ? ' combobox__chip--inactive' : ''}`}>
                    {text}
                    {option?.inactive && <span className="combobox__chip-note"> (inactif)</span>}
                    {!disabled && (
                      <button
                        type="button"
                        className="combobox__chip-remove"
                        aria-label={`Retirer « ${text} »`}
                        onClick={() => {
                          props.onChange(props.value.filter((value) => value !== id))
                          inputRef.current?.focus()
                        }}
                      >
                        <CloseIcon size={14} />
                      </button>
                    )}
                  </span>
                )
              })}
            <input
              {...a11y}
              ref={inputRef}
              className="combobox__input"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeItem ? optionId(active) : undefined}
              aria-required={required || undefined}
              autoComplete="off"
              disabled={disabled}
              placeholder={placeholder}
              value={inputValue}
              onChange={(event) => {
                setQuery(event.target.value)
                setOpen(true)
                setActiveIndex(0)
                setCreateError(null)
              }}
              onClick={() => {
                if (!open) openList()
              }}
              onKeyDown={handleKeyDown}
            />
            {!props.multiple && props.value && !required && !disabled && (
              <button
                type="button"
                className="combobox__button"
                aria-label={`Effacer « ${selectedLabel} »`}
                title="Effacer"
                onClick={() => {
                  props.onChange(null)
                  inputRef.current?.focus()
                }}
              >
                <CloseIcon size={16} />
              </button>
            )}
            {!disabled && (
              <button
                type="button"
                className="combobox__button"
                tabIndex={-1}
                aria-label={open ? 'Masquer les choix' : 'Afficher les choix'}
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => {
                  if (open) close()
                  else openList()
                  inputRef.current?.focus()
                }}
              >
                <ChevronDownIcon size={18} />
              </button>
            )}
          </div>
          {open && (
            <div className="combobox__popup">
              <ul id={listId} role="listbox" className="combobox__listbox" aria-label={label} aria-multiselectable={props.multiple || undefined}>
                {items.map((item, index) => {
                  const isActive = index === active
                  // Pointer presses keep the focus in the input.
                  const common = {
                    id: optionId(index),
                    role: 'option',
                    'data-active': isActive ? '' : undefined,
                    onMouseDown: (event: { preventDefault: () => void }) => {
                      event.preventDefault()
                    },
                    onMouseMove: () => {
                      if (!isActive) setActiveIndex(index)
                    },
                    onClick: () => {
                      choose(item)
                    },
                  } as const
                  if (item.kind === 'create') {
                    return (
                      <li key="create" {...common} aria-selected={false} className="combobox__option combobox__option--create">
                        {creating ? <SpinnerIcon size={16} className="combobox__spinner" /> : <PlusIcon size={16} />}
                        {creating ? 'Création…' : (create?.label?.(item.text) ?? `Créer « ${item.text} »`)}
                      </li>
                    )
                  }
                  const selected = selectedIds.includes(item.option.id)
                  return (
                    <li key={item.option.id} {...common} aria-selected={selected} className="combobox__option">
                      <CheckIcon size={16} className="combobox__check" />
                      <span className="combobox__option-text">
                        <span>{item.option.label}</span>
                        {item.option.hint && <span className="combobox__option-hint">{item.option.hint}</span>}
                      </span>
                      {item.option.inactive && <Badge>Inactif</Badge>}
                    </li>
                  )
                })}
              </ul>
              {status === 'loading' && <p className="combobox__note">Chargement…</p>}
              {status === 'error' && <p className="combobox__note">Liste indisponible. Réessayez plus tard.</p>}
              {status === 'ready' && items.length === 0 && !hiddenInactive && !refusal && (
                <p className="combobox__note">Aucun résultat.</p>
              )}
              {hiddenInactive && (
                <p className="combobox__note">
                  <InfoIcon size={16} />« {hiddenInactive.label} » existe mais est désactivé : réactivez-le dans
                  Paramètres pour le choisir.
                </p>
              )}
              {refusal && (
                <p className="combobox__note">
                  <InfoIcon size={16} />
                  {refusal}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </FieldFrame>
  )
}
