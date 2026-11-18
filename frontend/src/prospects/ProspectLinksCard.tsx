import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'

import { ApiError } from '../api/client'
import {
  otherSide,
  type PersonKind,
  type PersonLink,
  useLinkMutations,
  usePersonLinks,
  useRelationLabels,
} from '../api/links'
import { normalizeQuery, SEARCH_MIN_LENGTH, useSearch } from '../api/search'
import { useReferents } from '../api/settings'
import { hueIndex, initials } from '../prospection/graphLayout'
import { useDebouncedValue } from '../settings/shared'
import { Button, IconButton } from '../ui/Button'
import { Combobox, type ComboboxOption } from '../ui/Combobox'
import { TextField } from '../ui/fields'
import { CheckIcon, CloseIcon, PencilIcon, PlusIcon, TrashIcon, UsersIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import './links.css'

interface LinksCardProps {
  prospectId: string
  // Bumped by the sheet (context menu « Lier à… ») to open the add form and focus its first field.
  addRequest?: number
  // « Graph »: opens the Prospection graph on this prospect (the sheet asks before leaving with pending changes).
  onOpenGraph?: () => void
}

type Own = { kind: PersonKind; id: string }

const ADD_FIELD = 'person-links-target'

// « Relations » card (Profil tab, full-width row): who this person knows among the members of the organisation and
// the other prospects, how (« frère », « amis »…) and how well (0 to 100). Dense rows; « Lier à » adds inline. The
// same links feed the Prospection graph.
export function ProspectLinksCard({ prospectId, addRequest = 0, onOpenGraph }: LinksCardProps) {
  const links = usePersonLinks('prospect', prospectId)
  const own: Own = { kind: 'prospect', id: prospectId }
  const [adding, setAdding] = useState(false)
  const seenRequest = useRef(addRequest)

  // The context menu's « Lier à… »: open the form, then focus its first field once it is on screen.
  const focusPending = useRef(false)
  useEffect(() => {
    if (addRequest === seenRequest.current) return
    seenRequest.current = addRequest
    focusPending.current = true
    setAdding(true)
  }, [addRequest])
  // Once the form is rendered (and the menu has given the focus back): focus its first field.
  useEffect(() => {
    if (!focusPending.current || !adding) return
    const field = document.getElementById(ADD_FIELD)
    if (!field) return
    focusPending.current = false
    field.scrollIntoView({ block: 'nearest' })
    field.focus()
  })

  return (
    <EditorSection
      title="Relations"
      count={links.data?.length}
      actions={
        <>
          {onOpenGraph && (
            <Button size="sm" variant="ghost" icon={UsersIcon} title="Voir ce prospect dans le graphe de prospection" onClick={onOpenGraph}>
              Graph
            </Button>
          )}
          <Button
            size="sm"
            variant={adding ? 'ghost' : 'secondary'}
            icon={adding ? CloseIcon : PlusIcon}
            aria-expanded={adding}
            onClick={() => {
              setAdding(!adding)
            }}
          >
            {adding ? 'Annuler' : 'Lier à'}
          </Button>
        </>
      }
    >
      <div className="person-links">
        {links.isError && <p role="alert">Les relations n’ont pas pu être chargées.</p>}
        {links.data?.length === 0 && !adding && <p className="person-links__empty">Aucune relation enregistrée pour l’instant.</p>}
        {links.data && links.data.length > 0 && (
          <ul className="person-links__list" aria-label="Relations du prospect">
            {links.data.map((link) => (
              <LinkRow key={link.id} link={link} own={own} />
            ))}
          </ul>
        )}
        {adding && (
          <AddLink
            own={own}
            onDone={() => {
              setAdding(false)
            }}
          />
        )}
      </div>
    </EditorSection>
  )
}

// Initials on a stable hue, as on the Prospection graph (the base holds no photo).
function Avatar({ name }: { name: string }) {
  return (
    <span className="person-links__avatar" style={{ background: `var(--cohort-${String(hueIndex(name))})` }} aria-hidden="true">
      {initials(name)}
    </span>
  )
}

// The strength as a small meter and its number.
function Meter({ score }: { score: number }) {
  return (
    <span className="person-links__meter" role="img" aria-label={`Force du lien : ${String(score)} sur 100`} title={`Force du lien : ${String(score)}/100`}>
      <span className="person-links__bar">
        <span style={{ width: `${String(score)}%` }} />
      </span>
      <span className="person-links__number" aria-hidden="true">
        {score}
      </span>
    </span>
  )
}

function LinkRow({ link, own }: { link: PersonLink; own: Own }) {
  const { update, remove } = useLinkMutations()
  const relations = useRelationLabels()
  const listId = useId()
  const other = otherSide(link, own)
  const [editing, setEditing] = useState(false)
  const [relation, setRelation] = useState(link.relation)
  const [score, setScore] = useState(link.score)
  const [error, setError] = useState<string | null>(null)

  function startEdit() {
    setRelation(link.relation)
    setScore(link.score)
    setError(null)
    setEditing(true)
  }

  function save() {
    const label = relation.trim()
    if (!label) {
      setError('Indiquez la nature du lien.')
      return
    }
    if (label === link.relation && score === link.score) {
      setEditing(false)
      return
    }
    setError(null)
    update.mutate(
      { id: link.id, patch: { relation: label, score } },
      {
        onSuccess: () => {
          setEditing(false)
        },
        onError: (failure) => {
          setError(failure instanceof ApiError ? failure.message : 'Le lien n’a pas pu être enregistré.')
        },
      },
    )
  }

  const name =
    other.kind === 'prospect' ? (
      <Link to={`/prospection?prospect=${other.id}`} title={other.name}>
        {other.name}
      </Link>
    ) : (
      <strong title={other.name}>{other.name}</strong>
    )

  if (editing) {
    return (
      <li
        className="person-links__item person-links__item--editing"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setEditing(false)
          } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'range') {
            event.preventDefault()
            save()
          }
        }}
      >
        <Avatar name={other.name} />
        <span className="person-links__who">
          {name}
          <span className="person-links__kind">{other.kind === 'member' ? 'Membre' : (other.company_name ?? 'Prospect')}</span>
        </span>
        <div className="person-links__edit">
          <TextField
            label="Nature du lien"
            list={listId}
            value={relation}
            maxLength={80}
            onChange={(event) => {
              setRelation(event.target.value)
            }}
          />
          <datalist id={listId}>
            {(relations.data ?? []).map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          <label className="person-links__slider">
            <span>Force</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={score}
              aria-label={`Force du lien avec ${other.name}`}
              onChange={(event) => {
                setScore(Number(event.target.value))
              }}
            />
            <output>{score}</output>
          </label>
        </div>
        <span className="person-links__actions" data-open="">
          <IconButton label="Enregistrer le lien" icon={CheckIcon} size="sm" variant="primary" loading={update.isPending} onClick={save} />
          <IconButton
            label="Annuler la modification"
            icon={CloseIcon}
            size="sm"
            onClick={() => {
              setEditing(false)
            }}
          />
        </span>
        {error && (
          <p className="person-links__error" role="alert">
            {error}
          </p>
        )}
      </li>
    )
  }

  return (
    <li className="person-links__item">
      <Avatar name={other.name} />
      <span className="person-links__who">
        {name}
        <span className="person-links__kind">{other.kind === 'member' ? 'Membre' : (other.company_name ?? 'Prospect')}</span>
      </span>
      <span className="person-links__relation" title={link.relation}>
        {link.relation}
      </span>
      <Meter score={link.score} />
      <span className="person-links__actions">
        <IconButton label={`Modifier le lien avec ${other.name}`} icon={PencilIcon} size="sm" onClick={startEdit} />
        <IconButton
          label={`Supprimer le lien avec ${other.name}`}
          icon={TrashIcon}
          size="sm"
          loading={remove.isPending}
          onClick={() => {
            setError(null)
            remove.mutate(link.id, {
              onError: () => {
                setError('Le lien n’a pas pu être supprimé.')
              },
            })
          }}
        />
      </span>
      {error && (
        <p className="person-links__error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

function AddLink({ own, onDone }: { own: Own; onDone: () => void }) {
  const { create } = useLinkMutations()
  const members = useReferents()
  const relations = useRelationLabels()
  const listId = useId()
  const [typed, setTyped] = useState('')
  const query = normalizeQuery(useDebouncedValue(typed, 250))
  const found = useSearch(query.length >= SEARCH_MIN_LENGTH ? query : '')
  const [target, setTarget] = useState<string | null>(null)
  const [relation, setRelation] = useState('')
  const [score, setScore] = useState(50)
  const [error, setError] = useState<string | null>(null)

  const options: ComboboxOption[] = []
  for (const member of members.data ?? []) {
    if (!member.active) continue
    options.push({ id: `member:${member.id}`, label: member.display_name, hint: 'Membre de l’organisation' })
  }
  for (const group of found.data?.groups ?? []) {
    for (const hit of group.items) {
      if (hit.type !== 'prospect' || (own.kind === 'prospect' && hit.id === own.id)) continue
      options.push({ id: `prospect:${hit.id}`, label: hit.label, hint: hit.company_name ?? hit.sublabel ?? 'Prospect' })
    }
  }

  function submit() {
    setError(null)
    if (!target) {
      setError('Choisissez la personne liée.')
      return
    }
    if (!relation.trim()) {
      setError('Indiquez la nature du lien (frère, amis, ancien collègue…).')
      return
    }
    const [kind, id] = target.split(':') as [PersonKind, string]
    create.mutate(
      { a: own, b: { kind, id }, relation, score },
      {
        onSuccess: () => {
          setTarget(null)
          setRelation('')
          setScore(50)
          setTyped('')
          onDone()
        },
        onError: (failure) => {
          setError(failure instanceof ApiError ? failure.message : 'Le lien n’a pas pu être enregistré.')
        },
      },
    )
  }

  return (
    // Not a <form>: the card sits inside the editor's own form, and a nested submit would reach it.
    <div
      className="person-links__add"
      role="group"
      aria-label="Ajouter une relation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onDone()
        } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'range') {
          event.preventDefault()
          submit()
        }
      }}
    >
      <Combobox
        id={ADD_FIELD}
        label="Lié à"
        placeholder="Un membre ou un prospect…"
        value={target}
        options={options}
        status={members.isError ? 'error' : 'ready'}
        onChange={setTarget}
        onQueryChange={setTyped}
      />
      <TextField
        label="Nature du lien"
        placeholder="frère, amis, ancien collègue…"
        list={listId}
        value={relation}
        maxLength={80}
        onChange={(event) => {
          setRelation(event.target.value)
        }}
      />
      <datalist id={listId}>
        {(relations.data ?? []).map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <label className="person-links__slider">
        <span>Force du lien</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={score}
          onChange={(event) => {
            setScore(Number(event.target.value))
          }}
        />
        <output>{score}</output>
      </label>
      <Button variant="primary" icon={UsersIcon} loading={create.isPending} onClick={submit}>
        Ajouter le lien
      </Button>
      {error && (
        <p className="person-links__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
