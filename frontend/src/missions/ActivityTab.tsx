import { useEffect, useState } from 'react'

import {
  ACTIVITY_EVENT_TYPES,
  type ActivityEventType,
  type ActivityFilters,
  useMission,
  useMissionSessions,
} from '../api/missions'
import { Button } from '../ui/Button'
import { SelectField } from '../ui/fields'
import { AlertIcon, CloseIcon, RefreshIcon } from '../ui/icons'
import { ActivityLog } from './ActivityLog'
import { ActivitySessions } from './ActivitySessions'
import { absoluteMomentLabel, EVENT_TYPE_LABELS, sessionLabel } from './activityLabels'
import './activity.css'

interface TabProps {
  missionId: string
}

const SESSIONS_POLL_MS = 10_000
const SESSIONS_LIMIT = 100
const CLOCK_MS = 30_000

// Re-renders the relative times (« il y a 3 min ») while the tab is open, without refetching anything.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, CLOCK_MS)
    return () => {
      window.clearInterval(id)
    }
  }, [])
  return now
}

// « Activité » tab: who works on the mission now (sessions), and what they did (factual log). Both are polled while
// the browser tab is visible (react-query pauses hidden tabs). Filters are local to the tab.
export function ActivityTab({ missionId }: TabProps) {
  const now = useNow()
  const [agentId, setAgentId] = useState('')
  const [runId, setRunId] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [taskId, setTaskId] = useState<string | undefined>()
  const [types, setTypes] = useState<ActivityEventType[]>([])

  const mission = useMission(missionId)
  const sessions = useMissionSessions(missionId, { limit: SESSIONS_LIMIT }, SESSIONS_POLL_MS)

  const all = sessions.data?.items ?? []
  const agents = [...new Map(all.map((session) => [session.agent_id, session.agent_label])).entries()]
  const visible = all.filter(
    (session) => (!agentId || session.agent_id === agentId) && (!runId || session.run_id === runId),
  )
  const activeCount = all.filter((session) => session.status === 'active').length
  const runs = mission.data?.runs ?? []

  const logFilters: ActivityFilters = {
    ...(agentId && { agent_id: agentId }),
    ...(runId && { run_id: runId }),
    ...(sessionId && { session_id: sessionId }),
    ...(taskId && { task_id: taskId }),
    ...(types.length > 0 && { event_type: types }),
  }
  const filtered = Object.keys(logFilters).length > 0

  function reset() {
    setAgentId('')
    setRunId('')
    setSessionId(undefined)
    setTaskId(undefined)
    setTypes([])
  }

  return (
    <div className="activity" data-mission-id={missionId}>
      <section className="activity-block" aria-labelledby="activity-sessions-title">
        <div className="activity-block__head">
          <h2 id="activity-sessions-title" className="activity-block__title">
            Activité des agents
          </h2>
          <p className="missions-muted" aria-live="polite">
            {sessions.data
              ? `${String(activeCount)} agent${activeCount > 1 ? 's' : ''} en cours sur ${String(sessions.data.total)} session${sessions.data.total > 1 ? 's' : ''}`
              : ''}
          </p>
        </div>
        {sessions.isError && !sessions.data ? (
          <div className="activity-state" role="alert">
            <p className="missions-error">
              <AlertIcon size={16} /> Les sessions des agents sont indisponibles.
            </p>
            <Button
              size="sm"
              icon={RefreshIcon}
              loading={sessions.isFetching}
              onClick={() => {
                void sessions.refetch()
              }}
            >
              Réessayer
            </Button>
          </div>
        ) : !sessions.data ? (
          <p className="activity-state missions-muted" role="status">
            Chargement des sessions…
          </p>
        ) : all.length === 0 ? (
          <p className="activity-state missions-muted">
            Aucun agent n’a encore travaillé sur cette mission. Les sessions apparaissent dès qu’un agent prend une
            tâche.
          </p>
        ) : visible.length === 0 ? (
          <p className="activity-state missions-muted">Aucune session ne correspond à ces filtres.</p>
        ) : (
          <ActivitySessions
            sessions={visible}
            total={visible.length === all.length ? sessions.data.total : visible.length}
            now={now}
            selectedSessionId={sessionId}
            onSelect={setSessionId}
          />
        )}
        {sessions.isError && sessions.data && (
          <p className="missions-notice" role="status">
            Actualisation impossible : dernières sessions connues affichées.
          </p>
        )}
      </section>

      <section className="activity-block" aria-labelledby="activity-log-title">
        <h2 id="activity-log-title" className="activity-block__title">
          Journal d’activité
        </h2>
        <form
          className="activity-filters"
          aria-label="Filtres du journal"
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          <SelectField
            label="Agent"
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value)
              setSessionId(undefined)
            }}
          >
            <option value="">Tous les agents</option>
            {agents.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Exécution"
            value={runId}
            onChange={(event) => {
              setRunId(event.target.value)
              setSessionId(undefined)
            }}
          >
            <option value="">Toutes les exécutions</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {absoluteMomentLabel(run.scheduled_at)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Session"
            value={sessionId ?? ''}
            onChange={(event) => {
              setSessionId(event.target.value || undefined)
            }}
          >
            <option value="">Toutes les sessions</option>
            {visible.map((session) => (
              <option key={session.id} value={session.id}>
                {sessionLabel(session, now)}
              </option>
            ))}
          </SelectField>
          <fieldset className="activity-types">
            <legend>Type d’événement</legend>
            {ACTIVITY_EVENT_TYPES.map((type) => {
              const pressed = types.includes(type)
              return (
                <button
                  key={type}
                  type="button"
                  className="activity-chip"
                  aria-pressed={pressed}
                  onClick={() => {
                    setTypes(pressed ? types.filter((item) => item !== type) : [...types, type])
                  }}
                >
                  {EVENT_TYPE_LABELS[type]}
                </button>
              )
            })}
          </fieldset>
          {taskId && (
            <p className="activity-task-filter">
              Une seule tâche affichée
              <Button
                size="sm"
                icon={CloseIcon}
                onClick={() => {
                  setTaskId(undefined)
                }}
              >
                Retirer le filtre tâche
              </Button>
            </p>
          )}
          {filtered && (
            <Button size="sm" variant="ghost" onClick={reset}>
              Réinitialiser les filtres
            </Button>
          )}
        </form>
        <ActivityLog
          key={JSON.stringify(logFilters)}
          missionId={missionId}
          filters={logFilters}
          now={now}
          onFilterTask={setTaskId}
          empty={sessions.data?.total === 0}
        />
      </section>
    </div>
  )
}
