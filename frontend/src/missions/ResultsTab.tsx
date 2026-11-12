import { useState } from 'react'

import { ReviewDialog } from '../agents/ReviewDialog'
import { type MissionResultStatus, RESULT_STATUSES, useMission, useMissionResults } from '../api/missions'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { SelectField } from '../ui/fields'
import { CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons'
import { ResultsCard } from './ResultsCard'
import { RESULT_STATUS_LABELS } from './resultsLabels'
import './results.css'

interface TabProps {
  missionId: string
}

const PAGE_SIZE = 12
type StatusFilter = MissionResultStatus | 'all'

// Review queue of the mission (Slice 08): result cards, filtered by status / agent / run, each opening the validation
// dialog. Stable contract: `missionId` only. Decisions refresh this list through the review mutations.
export function ResultsTab({ missionId }: TabProps) {
  const [status, setStatus] = useState<StatusFilter>('pending_review')
  const [agent, setAgent] = useState('')
  const [run, setRun] = useState('')
  const [offset, setOffset] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  // Agents seen so far, so narrowing the list to one agent does not drop the others from the filter.
  const [agents, setAgents] = useState<Record<string, string>>({})

  const mission = useMission(missionId)
  const results = useMissionResults(missionId, {
    status: status === 'all' ? undefined : [status],
    agent_id: agent || undefined,
    run_id: run || undefined,
    limit: PAGE_SIZE,
    offset,
  })
  const page = results.data
  const unseen = page?.items.filter((item) => item.agent_id && agents[item.agent_id] === undefined) ?? []
  if (unseen.length > 0) {
    const added: Record<string, string> = {}
    for (const item of unseen) if (item.agent_id) added[item.agent_id] = item.agent_label
    setAgents({ ...agents, ...added })
  }

  const change = (apply: () => void) => {
    apply()
    setOffset(0)
  }
  const total = page?.total ?? 0
  const counts = page?.status_counts
  const allCount = counts ? RESULT_STATUSES.reduce((sum, key) => sum + counts[key], 0) : null
  const runs = mission.data?.runs ?? []
  const filtered = status !== 'pending_review' || agent !== '' || run !== ''

  return (
    <div className="results-tab" data-mission-id={missionId}>
      <div className="results-filters">
        <div role="group" aria-label="Statut du résultat" className="results-status">
          {(['all', ...RESULT_STATUSES] as const).map((key) => {
            const count = key === 'all' ? allCount : (counts?.[key] ?? null)
            return (
              <button
                key={key}
                type="button"
                className="results-status__chip"
                aria-pressed={status === key}
                onClick={() => {
                  change(() => {
                    setStatus(key)
                  })
                }}
              >
                {key === 'all' ? 'Tous' : RESULT_STATUS_LABELS[key]}
                {count !== null && <span className="results-status__count"> {String(count)}</span>}
              </button>
            )
          })}
        </div>
        <SelectField
          label="Agent"
          value={agent}
          onChange={(event) => {
            change(() => {
              setAgent(event.target.value)
            })
          }}
        >
          <option value="">Tous les agents</option>
          {Object.entries(agents).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Exécution"
          value={run}
          onChange={(event) => {
            change(() => {
              setRun(event.target.value)
            })
          }}
        >
          <option value="">Toutes les exécutions</option>
          {runs.map((item) => (
            <option key={item.id} value={item.id}>
              {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(
                new Date(item.scheduled_at),
              )}
            </option>
          ))}
        </SelectField>
      </div>

      {results.isLoading && (
        <p className="missions-muted" role="status">
          Chargement des résultats…
        </p>
      )}
      {results.isError && (
        <p className="missions-error" role="alert">
          Les résultats n’ont pas pu être chargés.{' '}
          <Button
            size="sm"
            onClick={() => {
              void results.refetch()
            }}
          >
            Réessayer
          </Button>
        </p>
      )}
      {page && page.items.length === 0 && (
        <EmptyState
          icon={CheckCircleIcon}
          title={filtered ? 'Aucun résultat pour ces filtres' : 'Rien à relire'}
          description={
            filtered
              ? 'Élargissez les filtres pour voir les autres résultats de la mission.'
              : 'Les propositions des agents à valider apparaîtront ici dès qu’elles seront soumises.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setStatus('all')
                  setAgent('')
                  setRun('')
                  setOffset(0)
                }}
              >
                Voir tous les résultats
              </Button>
            ) : undefined
          }
        />
      )}
      {page && page.items.length > 0 && (
        <ul className="results-list" aria-label="Résultats des agents">
          {page.items.map((item) => (
            <li key={item.id}>
              <ResultsCard card={item} onOpen={setOpenId} />
            </li>
          ))}
        </ul>
      )}
      {page && total > PAGE_SIZE && (
        <nav className="results-pager" aria-label="Pagination des résultats">
          <Button
            size="sm"
            icon={ChevronLeftIcon}
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE_SIZE))
            }}
          >
            Précédents
          </Button>
          <span aria-live="polite">
            {String(offset + 1)}–{String(Math.min(offset + PAGE_SIZE, total))} sur {String(total)}
          </span>
          <Button
            size="sm"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => {
              setOffset(offset + PAGE_SIZE)
            }}
          >
            Suivants
            <ChevronRightIcon size={16} />
          </Button>
        </nav>
      )}

      <ReviewDialog
        key={openId ?? 'closed'}
        resultId={openId}
        onClose={() => {
          setOpenId(null)
        }}
      />
    </div>
  )
}
