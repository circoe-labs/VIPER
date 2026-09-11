import { use, useState } from 'react'

import { type HistoryChange, type HistoryEntry, type HistorySubject, useHistory } from '../api/history'
import { CurrentUserContext } from '../auth/currentUser'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon } from '../ui/icons'
import { absoluteMoment, actorBadge, actorDetails, relativeMoment } from './format'
import './history.css'

// Change lines shown before « Afficher les N autres » (a creation lists every field).
const VISIBLE_CHANGES = 5

function ChangeLine({ change }: { change: HistoryChange }) {
  const values = [change.before, change.after].filter((value): value is string => value !== null)
  return (
    <li className="history-change">
      <span className="history-change__label">{change.label}</span>
      {values.length > 0 && ' : '}
      {values.map((value, index) => (
        <span key={index}>
          {index > 0 && <span className="history-change__arrow"> → </span>}
          <span className={index === 0 && values.length > 1 ? 'history-change__before' : 'history-change__after'}>
            {value}
          </span>
        </span>
      ))}
    </li>
  )
}

function Entry({ entry, currentUserId, now }: { entry: HistoryEntry; currentUserId: string | null; now: number }) {
  const [expanded, setExpanded] = useState(false)
  const badge = actorBadge(entry.actor, currentUserId)
  const relative = relativeMoment(entry.occurred_at, now)
  const hidden = entry.changes.length - VISIBLE_CHANGES
  const changes = expanded || hidden <= 1 ? entry.changes : entry.changes.slice(0, VISIBLE_CHANGES)
  return (
    <li className="history-entry">
      <div className="history-entry__head">
        <Badge tone={badge.tone}>{badge.text}</Badge>
        <span className="history-entry__meta">
          {[...actorDetails(entry.actor, entry.source), relative].filter(Boolean).join(' · ')}
          {' · '}
          <time dateTime={entry.occurred_at}>{absoluteMoment(entry.occurred_at)}</time>
        </span>
      </div>
      <p className="history-entry__title">{entry.title}</p>
      {changes.length > 0 && (
        <ul className="history-entry__changes">
          {changes.map((change, index) => (
            <ChangeLine key={index} change={change} />
          ))}
        </ul>
      )}
      {hidden > 1 && (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value)
          }}
        >
          {expanded ? 'Masquer le détail' : `Afficher les ${String(hidden)} autres`}
        </Button>
      )}
    </li>
  )
}

interface HistoryTimelineProps {
  subject: HistorySubject
  id: string
  label: string
}

// Readable history of a prospect or a company (Task 19): who (« Vous », a person, « Import « fichier » », « Système »,
// « Agent »), from where, when, and what changed — one entry per save, the latest first, older ones on « Voir plus ».
// Not a compliance log and no rollback: raw audit data stays on the server.
export function HistoryTimeline({ subject, id, label }: HistoryTimelineProps) {
  const history = useHistory(subject, id)
  const currentUserId = use(CurrentUserContext)?.id ?? null
  // Relative dates are counted from the last read (a refresh after a save moves it).
  const now = history.dataUpdatedAt
  if (history.isPending) return <p className="history__state">Chargement de l’historique…</p>
  if (history.isError) {
    return (
      <div className="history__state history__state--error" role="alert">
        <AlertIcon size={16} />
        Historique indisponible.
        <Button size="sm" onClick={() => void history.refetch()}>
          Réessayer
        </Button>
      </div>
    )
  }
  const entries = history.data.pages.flatMap((page) => page.items)
  if (entries.length === 0) return <p className="history__state">Aucune modification enregistrée pour l’instant.</p>
  return (
    <div className="history">
      <ol className="history__list" aria-label={label}>
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} currentUserId={currentUserId} now={now} />
        ))}
      </ol>
      {history.hasNextPage && (
        <Button size="sm" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          Voir plus
        </Button>
      )}
    </div>
  )
}
