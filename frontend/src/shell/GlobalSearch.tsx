import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import {
  normalizeQuery,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  type SearchHit,
  type SearchType,
  useSearch,
} from '../api/search'
import { useCompanyEditor } from '../companies/CompanyEditorProvider'
import { formatSiren, formatSiret } from '../companies/companyForm'
import { recordHref } from '../database/explorerView'
import { prospectionHref } from '../prospection/criteria'
import { formatPhone } from '../prospection/labels'
import { useDebouncedValue } from '../settings/shared'
import { Badge, StatusBadge } from '../ui/Badge'
import {
  AlertIcon,
  BuildingIcon,
  CloseIcon,
  type IconComponent,
  MapPinIcon,
  SearchIcon,
  SpinnerIcon,
  TableIcon,
  UsersIcon,
} from '../ui/icons'
import './global-search.css'

// Global search of the shell (Task 17): one field in the header, Ctrl+K or « / » from anywhere, results grouped by
// kind in a WAI-ARIA combobox + listbox. Matching and ranking are the backend's (doc/features/global-search.md).

export const SEARCH_DEBOUNCE_MS = 200
const PLACEHOLDER = 'Rechercher un prospect, une entreprise, un SIREN…'
const RECORD_LABEL = 'Voir dans la base de données'

const GROUPS: Record<SearchType, { label: string; icon: IconComponent }> = {
  prospect: { label: 'Prospects', icon: UsersIcon },
  company: { label: 'Entreprises', icon: BuildingIcon },
  establishment: { label: 'Établissements', icon: MapPinIcon },
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count > 1 ? many : one}`
}

// Where typing « / » means the character, not the shortcut.
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

function present(part: string | null): part is string {
  return Boolean(part)
}

// The secondary line of a result: its context and, when the label does not show it, the value that matched.
function details(hit: SearchHit): string[] {
  const { field, value } = hit.match
  switch (hit.type) {
    case 'prospect': {
      const matched =
        field === 'email' && value ? value : field === 'phone' && value ? formatPhone(value) : null
      return [hit.sublabel, hit.company_name, matched].filter(present)
    }
    case 'company': {
      const website = field === 'website' ? value : null
      return [
        hit.sublabel,
        hit.siren && `SIREN ${formatSiren(hit.siren)}`,
        hit.email_domain,
        website,
        hit.city,
        plural(hit.prospect_count, 'prospect', 'prospects'),
      ].filter(present)
    }
    case 'establishment':
      return [hit.company_name, hit.siret && `SIRET ${formatSiret(hit.siret)}`, hit.sublabel].filter(present)
  }
}

function HitBadges({ hit }: { hit: SearchHit }) {
  if (hit.badges.length === 0) return null
  return (
    <span className="global-search__badges">
      {hit.badges.includes('do_not_contact') && <StatusBadge tone="danger">Ne pas contacter</StatusBadge>}
      {hit.badges.includes('inactive') && <StatusBadge tone="neutral">Inactif</StatusBadge>}
      {hit.badges.includes('primary') && <Badge>Principal</Badge>}
    </span>
  )
}

export function GlobalSearch() {
  const navigate = useNavigate()
  const openCompanyEditor = useCompanyEditor()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  // The active option, for the query it was chosen in (a new query starts on its first result).
  const [active, setActive] = useState({ query: '', index: 0 })

  const query = normalizeQuery(text)
  const settled = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
  const search = useSearch(settled)
  const results = settled.length >= SEARCH_MIN_LENGTH ? search.data : undefined
  // Results of an earlier query (typing, or the request in flight): shown dimmed, never opened.
  const stale = settled !== query || search.isPlaceholderData
  const hits = results?.groups.flatMap((group) => group.items) ?? []
  const activeIndex = active.query === settled ? Math.min(active.index, hits.length - 1) : 0
  const visible = open && query.length > 0
  // The listbox is rendered: results to show (the notes — hint, loading, none, error — are announced as status).
  const listed = visible && query.length >= SEARCH_MIN_LENGTH && !(search.isError && !stale) && hits.length > 0
  const activeHit = visible && !stale ? hits[activeIndex] : undefined

  // Ctrl+K (⌘K) anywhere, « / » outside text fields. Not while a dialog (editor, confirmation) holds the focus.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const modified = event.ctrlKey || event.metaKey
      const shortcut =
        (modified && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') ||
        (event.key === '/' && !modified && !event.altKey && !isTypingTarget(event.target))
      if (!shortcut) return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
      setOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function reset() {
    setOpen(false)
    setText('')
  }

  function openHit(hit: SearchHit) {
    reset()
    if (hit.open.editor === 'company') openCompanyEditor(hit.open.id)
    else void navigate(prospectionHref({ prospect: hit.open.id }))
  }

  function openRecord(hit: SearchHit) {
    reset()
    void navigate(recordHref(hit.record.table, hit.record.id))
  }

  function move(step: number) {
    if (hits.length === 0 || stale) return
    setActive({ query: settled, index: (activeIndex + step + hits.length) % hits.length })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        if (!visible) setOpen(true)
        else move(event.key === 'ArrowDown' ? 1 : -1)
        break
      case 'Enter':
        if (activeHit) {
          event.preventDefault()
          if (event.shiftKey) openRecord(activeHit)
          else openHit(activeHit)
        }
        break
      case 'Escape':
        if (visible) {
          event.preventDefault()
          setOpen(false)
        } else if (text) {
          event.preventDefault()
          setText('')
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!rootRef.current?.contains(event.relatedTarget)) setOpen(false)
  }

  const optionId = (index: number) => `${id}-option-${String(index)}`
  const status = !visible
    ? ''
    : query.length < SEARCH_MIN_LENGTH
      ? ''
      : stale || !results
        ? 'Recherche en cours…'
        : hits.length === 0
          ? 'Aucun résultat.'
          : plural(hits.length, 'résultat', 'résultats')

  let body
  if (query.length < SEARCH_MIN_LENGTH) {
    body = <p className="global-search__note">Saisissez au moins {SEARCH_MIN_LENGTH} caractères.</p>
  } else if (search.isError && !stale) {
    body = (
      <div className="global-search__note global-search__note--error" role="alert">
        <AlertIcon size={16} />
        <span>La recherche a échoué.</span>
        <button type="button" className="global-search__retry" onClick={() => void search.refetch()}>
          Réessayer
        </button>
      </div>
    )
  } else if (!results) {
    body = (
      <p className="global-search__note">
        <SpinnerIcon size={16} className="global-search__spinner" />
        Recherche…
      </p>
    )
  } else if (results.groups.length === 0) {
    body = <p className="global-search__note">{stale ? 'Recherche…' : `Aucun résultat pour « ${results.query} ».`}</p>
  } else {
    const starts = results.groups.map((_, position) =>
      results.groups.slice(0, position).reduce((count, group) => count + group.items.length, 0),
    )
    body = (
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Résultats de la recherche"
        aria-busy={stale || undefined}
        className="global-search__list"
        data-stale={stale ? '' : undefined}
      >
        {results.groups.map((group, position) => {
          const { label, icon: Icon } = GROUPS[group.type]
          const more = group.has_more ? ' — premiers résultats, précisez la recherche pour les autres' : ''
          return (
            <div key={group.type} role="group" aria-label={`${label}${more}`} className="global-search__group">
              <p className="global-search__group-title" aria-hidden="true">
                {label}
                {group.has_more && <span className="global-search__more">Premiers résultats · précisez la recherche</span>}
              </p>
              {group.items.map((hit, offset) => {
                const current = (starts[position] ?? 0) + offset
                const isActive = current === activeIndex && !stale
                return (
                  <div
                    key={`${hit.type}-${hit.id}`}
                    id={optionId(current)}
                    role="option"
                    aria-selected={isActive}
                    className="global-search__option"
                    data-active={isActive ? '' : undefined}
                    // Pointer presses keep the focus in the field.
                    onMouseDown={(event) => {
                      event.preventDefault()
                    }}
                    onMouseMove={() => {
                      if (!isActive && !stale) setActive({ query: settled, index: current })
                    }}
                    onClick={() => {
                      if (!stale) openHit(hit)
                    }}
                  >
                    <span className="global-search__icon">
                      <Icon size={16} />
                    </span>
                    <span className="global-search__text">
                      <span className="global-search__label">{hit.label}</span>{' '}
                      <span className="global-search__details">{details(hit).join(' · ')}</span>
                    </span>{' '}
                    <HitBadges hit={hit} />
                    <button
                      type="button"
                      tabIndex={-1}
                      className="global-search__record"
                      aria-label={`${RECORD_LABEL} : ${hit.label}`}
                      title={`${RECORD_LABEL} (Maj+Entrée)`}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (!stale) openRecord(hit)
                      }}
                    >
                      <TableIcon size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="global-search" onBlur={handleBlur}>
      <div className="global-search__field">
        <SearchIcon size={16} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Recherche globale"
          aria-expanded={listed}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeHit ? optionId(activeIndex) : undefined}
          aria-keyshortcuts="Control+K /"
          autoComplete="off"
          spellCheck={false}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
        />
        {search.isFetching && query.length >= SEARCH_MIN_LENGTH ? (
          <SpinnerIcon size={16} className="global-search__spinner" aria-hidden="true" />
        ) : text ? (
          <button
            type="button"
            tabIndex={-1}
            className="global-search__clear"
            aria-label="Effacer la recherche"
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            onClick={() => {
              setText('')
              inputRef.current?.focus()
            }}
          >
            <CloseIcon size={14} />
          </button>
        ) : (
          <kbd className="global-search__kbd" aria-hidden="true">
            Ctrl K
          </kbd>
        )}
      </div>
      {visible && (
        <div className="global-search__popup">
          {body}
          <p className="global-search__hints" aria-hidden="true">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> naviguer
            </span>
            <span>
              <kbd>Entrée</kbd> ouvrir
            </span>
            <span>
              <kbd>Maj</kbd>+<kbd>Entrée</kbd> base de données
            </span>
            <span>
              <kbd>Échap</kbd> fermer
            </span>
          </p>
        </div>
      )}
      <p className="visually-hidden" role="status">
        {status}
      </p>
    </div>
  )
}
