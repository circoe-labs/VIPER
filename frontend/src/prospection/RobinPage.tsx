import { useQueryClient } from '@tanstack/react-query'
import { type SyntheticEvent, useCallback, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { ApiError } from '../api/client'
import { fetchProspectPage, type ProspectListCriteria, type ProspectRow, useProspectPage } from '../api/prospection'
import { notesBatchKey, type ProspectNote, useNoteMutations, useNotesOfMany } from '../api/prospectNotes'
import { refreshAfterWrite } from '../api/refresh'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { TextField } from '../ui/fields'
import { ChevronLeftIcon, ChevronRightIcon, UsersIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { Table } from '../ui/Table'
import { useProspectEditor } from './prospectEditor'
import { createProspectQueue, type ProspectQueue } from './queue'
import { DOES_NOT_KNOW_ROBIN, KNOWS_ROBIN, readNotes, type RobinState, todayIso } from './robin'
import './robin.css'

// Tous les prospects valides (verts : emploi et e-mail principal vérifiés) en une liste, pour noter un par un qui connaît
// ou non Robin et ajouter une remarque libre. Chaque clic écrit une note du prospect (API des notes existante).

// Valides = relecture « Vérifié » de la Prospection, triés par entreprise.
const CRITERIA: ProspectListCriteria = {
  q: '',
  role: null,
  activity: null,
  referent: null,
  tracking_status: null,
  cohort: null,
  company: null,
  import_batch: null,
  segment: 'all',
  review: 'verified',
  sort: 'company',
}
const PAGE_SIZE = 50

function fullName(row: ProspectRow): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Sans nom'
}

// The page number and the open fiche live in the URL (`?page=2&prospect=<id>`): Back closes the fiche, a link reopens it.
function positive(value: string | null): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : 1
}

export function RobinPage() {
  const queryClient = useQueryClient()
  const { Editor } = useProspectEditor()
  const [params, setParams] = useSearchParams()
  const page = positive(params.get('page'))
  const openId = params.get('prospect')
  const list = useProspectPage(CRITERIA, page)
  const update = useCallback(
    (changes: { page?: number; prospect?: string | null }) => {
      const next = new URLSearchParams(params)
      if (changes.page !== undefined) next.set('page', String(changes.page))
      if (changes.prospect !== undefined) {
        if (changes.prospect) next.set('prospect', changes.prospect)
        else next.delete('prospect')
      }
      setParams(next)
    },
    [params, setParams],
  )
  const setPage = (number: number) => {
    update({ page: number })
  }
  // The list order when the fiche opened, for « Enregistrer et suivant »; it ends when the fiche closes.
  const [queue, setQueue] = useState<ProspectQueue | null>(null)
  if (openId === null && queue !== null) setQueue(null)
  if (openId !== null && queue === null && list.data && !list.isPlaceholderData) {
    setQueue(createProspectQueue(CRITERIA, { page, data: list.data }, (number) => fetchProspectPage(queryClient, CRITERIA, number)))
  }
  const rows = useMemo(() => list.data?.items ?? [], [list.data])
  const ids = useMemo(() => rows.map((row) => row.id), [rows])
  const notes = useNotesOfMany(ids)
  const byProspect = useMemo(() => {
    const grouped = new Map<string, ProspectNote[]>()
    for (const note of notes.data ?? []) grouped.set(note.prospect_id, [...(grouped.get(note.prospect_id) ?? []), note])
    return grouped
  }, [notes.data])
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="robin">
      <PageHeader
        title="Qui connaît Robin ?"
        description="Les prospects valides, avec une note pour dire s’ils connaissent Robin ou non, et une remarque libre."
        actions={
          <Link to="/prospection" className="btn btn--ghost btn--md">
            Retour à la Prospection
          </Link>
        }
      />
      {openId !== null && queue !== null && (
        <Editor
          target={openId}
          queue={queue}
          onNavigate={(target, options) => {
            update({ prospect: target, ...options })
          }}
        />
      )}
      {list.isError && <p role="alert">La liste n’a pas pu être chargée.</p>}
      {list.isSuccess && rows.length === 0 && (
        <EmptyState icon={UsersIcon} title="Aucun prospect valide" description="Les fiches validées dans l’espace de vérification apparaissent ici." />
      )}
      {rows.length > 0 && (
        <>
          <p className="robin__count" aria-live="polite">
            {total} prospect{total > 1 ? 's' : ''} valide{total > 1 ? 's' : ''}
            {notes.isError && ' · les notes n’ont pas pu être chargées'}
          </p>
          <Table caption="Prospects valides et note « connaît Robin »">
            <thead>
              <tr>
                <th scope="col">Prospect</th>
                <th scope="col">Entreprise</th>
                <th scope="col">Robin</th>
                <th scope="col">Remarque</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RobinRow
                  key={row.id}
                  row={row}
                  notes={byProspect.get(row.id) ?? []}
                  loaded={notes.isSuccess}
                  openHref={`?${new URLSearchParams({ page: String(page), prospect: row.id }).toString()}`}
                />
              ))}
            </tbody>
          </Table>
          {pages > 1 && (
            <nav className="robin__pager" aria-label="Pagination">
              <Button
                icon={ChevronLeftIcon}
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1)
                }}
              >
                Précédent
              </Button>
              <span>
                Page {page} sur {pages}
              </span>
              <Button
                disabled={page >= pages}
                onClick={() => {
                  setPage(page + 1)
                }}
              >
                Suivant
                <ChevronRightIcon size={16} />
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  )
}

interface RobinRowProps {
  row: ProspectRow
  notes: readonly ProspectNote[]
  loaded: boolean
  // Link that opens the prospect's fiche over this list.
  openHref: string
}

function RobinRow({ row, notes, loaded, openHref }: RobinRowProps) {
  const queryClient = useQueryClient()
  const { create } = useNoteMutations(row.id)
  const { state, remark } = readNotes(notes)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  function write(factText: string, done?: () => void) {
    setError(null)
    create.mutate(
      { fact_text: factText, noted_on: todayIso() },
      {
        onSuccess: () => {
          done?.()
          void refreshAfterWrite(queryClient, [notesBatchKey])
        },
        onError: (failure) => {
          setError(failure instanceof ApiError ? failure.message : 'L’enregistrement a échoué. Réessayez.')
        },
      },
    )
  }

  function choose(next: RobinState) {
    if (state !== next) write(next === 'knows' ? KNOWS_ROBIN : DOES_NOT_KNOW_ROBIN)
  }

  function addRemark(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    write(value, () => {
      setText('')
    })
  }

  const name = fullName(row)
  return (
    <tr>
      <td>
        <Link to={openHref} className="robin__open" aria-label={`Ouvrir la fiche de ${name}`}>
          <strong>{name}</strong>
        </Link>
        {row.exact_job_title && <div className="robin__muted">{row.exact_job_title}</div>}
      </td>
      <td>{row.company_name ?? '—'}</td>
      <td>
        <div className="robin__choice" role="group" aria-label={`Robin : ${name}`}>
          <Button
            size="sm"
            variant={state === 'knows' ? 'primary' : 'secondary'}
            aria-pressed={state === 'knows'}
            disabled={!loaded || create.isPending}
            onClick={() => {
              choose('knows')
            }}
          >
            Connaît
          </Button>
          <Button
            size="sm"
            variant={state === 'unknown' ? 'primary' : 'secondary'}
            aria-pressed={state === 'unknown'}
            disabled={!loaded || create.isPending}
            onClick={() => {
              choose('unknown')
            }}
          >
            Ne connaît pas
          </Button>
        </div>
      </td>
      <td>
        {remark && <div className="robin__remark">{remark.fact_text}</div>}
        <form className="robin__form" onSubmit={addRemark}>
          <TextField
            label={`Remarque pour ${name}`}
            value={text}
            maxLength={1000}
            placeholder="Ajouter une remarque…"
            onChange={(event) => {
              setText(event.target.value)
            }}
          />
          <Button size="sm" type="submit" disabled={!text.trim() || create.isPending}>
            Ajouter
          </Button>
        </form>
        {error && (
          <p className="robin__error" role="alert">
            {error}
          </p>
        )}
      </td>
    </tr>
  )
}
