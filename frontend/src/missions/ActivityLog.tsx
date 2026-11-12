import { useState } from 'react'

import { type ActivityEntry, type ActivityFilters, useMissionActivity } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, LinkIcon, RefreshIcon } from '../ui/icons'
import {
  absoluteMomentLabel,
  EVENT_TYPE_TONES,
  safeSourceUrl,
  sourceDateLabel,
} from './activityLabels'
import { relativeMomentLabel } from './labels'
import { EVENT_TYPE_LABELS } from './vocabulary'

export const PAGE_SIZE = 50

interface EntryProps {
  entry: ActivityEntry
  now: number
  onFilterTask: (taskId: string) => void
}

function ActivityRow({ entry, now, onFilterTask }: EntryProps) {
  const source = safeSourceUrl(entry.source_url)
  const published = sourceDateLabel(entry.source_published_at)
  return (
    <li className={`activity-entry is-${entry.event_type}`}>
      <div className="activity-entry__meta">
        <StatusBadge tone={EVENT_TYPE_TONES[entry.event_type]}>{EVENT_TYPE_LABELS[entry.event_type]}</StatusBadge>
        <span className="activity-entry__agent">{entry.agent_label}</span>
        <time dateTime={entry.created_at} title={absoluteMomentLabel(entry.created_at)}>
          {relativeMomentLabel(entry.created_at, now)}
        </time>
      </div>
      <p className="activity-entry__message">{entry.message}</p>
      {(entry.source_url || entry.task_id) && (
        <p className="activity-entry__links">
          {entry.source_url &&
            (source ? (
              <a href={source.href} target="_blank" rel="noopener noreferrer">
                <LinkIcon size={14} />
                {source.hostname}
                <span className="visually-hidden"> (source, s’ouvre dans un nouvel onglet)</span>
              </a>
            ) : (
              <span className="missions-muted">{entry.source_url}</span>
            ))}
          {entry.source_url && (
            <span className="missions-muted">
              {published ? `Publiée le ${published}` : 'Date de publication inconnue'}
            </span>
          )}
          {entry.task_id && (
            <button
              type="button"
              className="activity-entry__task"
              onClick={() => {
                if (entry.task_id) onFilterTask(entry.task_id)
              }}
            >
              Journal de la tâche
              <span className="visually-hidden"> {entry.task_id}</span>
            </button>
          )}
        </p>
      )}
    </li>
  )
}

interface PageProps {
  missionId: string
  filters: ActivityFilters
  now: number
  onFilterTask: (taskId: string) => void
}

// Older pages: one component per cursor so each keeps its own loading/error state. `seen` drops entries already
// shown above (the polled first page shifts when new logs arrive, so its tail can overlap the next page).
function OlderPage({ cursor, seen, ...rest }: PageProps & { cursor: string; seen: ReadonlySet<string> }) {
  const query = useMissionActivity(rest.missionId, {
    ...rest.filters,
    before: cursor,
    limit: PAGE_SIZE,
  })
  if (query.isError) {
    return (
      <li className="activity-log__more">
        <p className="missions-error" role="alert">
          <AlertIcon size={16} /> Impossible de charger les entrées plus anciennes.
        </p>
        <Button
          size="sm"
          icon={RefreshIcon}
          loading={query.isFetching}
          onClick={() => {
            void query.refetch()
          }}
        >
          Réessayer
        </Button>
      </li>
    )
  }
  if (!query.data) {
    return (
      <li className="activity-log__more" role="status">
        Chargement des entrées plus anciennes…
      </li>
    )
  }
  const items = query.data.items.filter((entry) => !seen.has(entry.id))
  return (
    <>
      {items.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} now={rest.now} onFilterTask={rest.onFilterTask} />
      ))}
      <LoadMore
        {...rest}
        cursor={query.data.next_cursor}
        seen={new Set([...seen, ...query.data.items.map((entry) => entry.id)])}
      />
    </>
  )
}

function LoadMore({ cursor, seen, ...rest }: PageProps & { cursor: string | null; seen: ReadonlySet<string> }) {
  const [requested, setRequested] = useState(false)
  if (!cursor) return null
  if (requested) return <OlderPage {...rest} cursor={cursor} seen={seen} />
  return (
    <li className="activity-log__more">
      <Button
        onClick={() => {
          setRequested(true)
        }}
      >
        Charger les entrées plus anciennes
      </Button>
    </li>
  )
}

interface ActivityLogProps extends PageProps {
  empty: boolean
}

// Factual log stream, newest first. The first page is polled; older pages are loaded on demand.
export function ActivityLog({ missionId, filters, now, onFilterTask, empty }: ActivityLogProps) {
  const first = useMissionActivity(missionId, { ...filters, limit: PAGE_SIZE }, 10_000)

  if (first.isError && !first.data) {
    return (
      <div className="activity-state" role="alert">
        <p className="missions-error">
          <AlertIcon size={16} /> Le journal d’activité est indisponible.
        </p>
        <Button
          size="sm"
          icon={RefreshIcon}
          loading={first.isFetching}
          onClick={() => {
            void first.refetch()
          }}
        >
          Réessayer
        </Button>
      </div>
    )
  }
  if (!first.data) {
    return (
      <p className="activity-state missions-muted" role="status">
        Chargement du journal…
      </p>
    )
  }
  if (first.data.items.length === 0) {
    const filtered = Object.keys(filters).length > 0
    return (
      <p className="activity-state missions-muted">
        {filtered
          ? 'Aucune entrée ne correspond à ces filtres.'
          : empty
            ? 'Aucune entrée pour l’instant : elles apparaîtront dès qu’un agent journalise une recherche.'
            : 'Les sessions existent mais aucune entrée n’a encore été journalisée.'}
      </p>
    )
  }
  return (
    <>
      {first.isError && (
        <p className="missions-notice" role="status">
          Actualisation impossible : dernières entrées connues affichées.
        </p>
      )}
      <ol className="activity-log" aria-label="Journal d’activité, du plus récent au plus ancien">
        {first.data.items.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} now={now} onFilterTask={onFilterTask} />
        ))}
        <LoadMore
          missionId={missionId}
          filters={filters}
          now={now}
          onFilterTask={onFilterTask}
          cursor={first.data.next_cursor}
          seen={new Set(first.data.items.map((entry) => entry.id))}
        />
      </ol>
    </>
  )
}
