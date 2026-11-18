import { useState } from 'react'
import { Link } from 'react-router'

import { ApiError } from '../api/client'
import {
  otherSide,
  type Person,
  type PersonKind,
  type PersonLink,
  useLinkMutations,
  usePersonLinks,
  useRelationLabels,
} from '../api/links'
import { normalizeQuery, SEARCH_MIN_LENGTH, useSearch } from '../api/search'
import { useReferents } from '../api/settings'
import { useDebouncedValue } from '../settings/shared'
import { Button, IconButton } from '../ui/Button'
import { Combobox, type ComboboxOption } from '../ui/Combobox'
import { TextField } from '../ui/fields'
import { TrashIcon, UsersIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import './links.css'

interface LinksCardProps {
  prospectId: string
}

// « Relations » card (Profil tab, right column): who this person knows among the members of the organisation and the
// other prospects, how (« frère », « amis »…) and how well (0 to 100). The same links feed the Prospection graph.
export function ProspectLinksCard({ prospectId }: LinksCardProps) {
  const links = usePersonLinks('prospect', prospectId)
  const own = { kind: 'prospect', id: prospectId } as const
  return (
    <EditorSection title="Relations" count={links.data?.length}>
      <div className="person-links">
        {links.isError && <p role="alert">Les relations n’ont pas pu être chargées.</p>}
        {links.data?.length === 0 && <p className="person-links__empty">Aucune relation enregistrée pour l’instant.</p>}
        {links.data && links.data.length > 0 && (
          <ul className="person-links__list" aria-label="Relations du prospect">
            {links.data.map((link) => (
              <LinkRow key={link.id} link={link} own={own} />
            ))}
          </ul>
        )}
        <AddLink own={own} />
      </div>
    </EditorSection>
  )
}

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="person-links__bar" role="img" aria-label={`Force du lien : ${String(score)} sur 100`}>
      <span style={{ width: `${String(score)}%` }} />
    </span>
  )
}

function LinkRow({ link, own }: { link: PersonLink; own: { kind: PersonKind; id: string } }) {
  const { update, remove } = useLinkMutations()
  const other = otherSide(link, own)
  const [score, setScore] = useState(link.score)
  const [error, setError] = useState<string | null>(null)

  function commit(value: number) {
    if (value === link.score) return
    update.mutate(
      { id: link.id, patch: { score: value } },
      {
        onError: () => {
          setScore(link.score)
          setError('La force n’a pas pu être enregistrée.')
        },
      },
    )
  }

  return (
    <li className="person-links__item">
      <div className="person-links__who">
        {other.kind === 'prospect' ? (
          <Link to={`/prospection?prospect=${other.id}`}>{other.name}</Link>
        ) : (
          <strong>{other.name}</strong>
        )}
        <span className="person-links__kind">{other.kind === 'member' ? 'Membre' : (other.company_name ?? 'Prospect')}</span>
      </div>
      <span className="person-links__relation">{link.relation}</span>
      <label className="person-links__score">
        <ScoreBar score={score} />
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
          onPointerUp={() => {
            commit(score)
          }}
          onKeyUp={() => {
            commit(score)
          }}
          onBlur={() => {
            commit(score)
          }}
        />
        <output>{score}/100</output>
      </label>
      <IconButton
        label={`Supprimer le lien avec ${other.name}`}
        icon={TrashIcon}
        size="sm"
        onClick={() => {
          remove.mutate(link.id)
        }}
      />
      {error && <p role="alert">{error}</p>}
    </li>
  )
}

function AddLink({ own }: { own: { kind: PersonKind; id: string } }) {
  const { create } = useLinkMutations()
  const members = useReferents()
  const relations = useRelationLabels()
  const [typed, setTyped] = useState('')
  const query = normalizeQuery(useDebouncedValue(typed, 250))
  const found = useSearch(query.length >= SEARCH_MIN_LENGTH ? query : '')
  const [target, setTarget] = useState<string | null>(null)
  const [relation, setRelation] = useState('')
  const [score, setScore] = useState(50)
  const [error, setError] = useState<string | null>(null)

  const people = new Map<string, Person>()
  const options: ComboboxOption[] = []
  for (const member of members.data ?? []) {
    if (!member.active) continue
    options.push({ id: `member:${member.id}`, label: member.display_name, hint: 'Membre de l’organisation' })
    people.set(`member:${member.id}`, { kind: 'member', id: member.id, name: member.display_name, company_id: null, company_name: null })
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
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'range') {
          event.preventDefault()
          submit()
        }
      }}
    >
      <Combobox
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
        list="person-links-relations"
        value={relation}
        maxLength={80}
        onChange={(event) => {
          setRelation(event.target.value)
        }}
      />
      <datalist id="person-links-relations">
        {(relations.data ?? []).map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <label className="person-links__score person-links__score--new">
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
        <output>{score}/100</output>
      </label>
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" icon={UsersIcon} loading={create.isPending} onClick={submit}>
        Ajouter le lien
      </Button>
    </div>
  )
}
