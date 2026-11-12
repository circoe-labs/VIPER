import type { AgentSession } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon } from '../ui/icons'
import {
  absoluteMomentLabel,
  DISCONNECT_REASON_LABELS,
  logsCountLabel,
  SESSION_STATUS_LABELS,
  SESSION_STATUS_TONES,
} from './activityLabels'
import { relativeMomentLabel } from './labels'

interface ActivitySessionsProps {
  sessions: AgentSession[]
  total: number
  now: number
  selectedSessionId: string | undefined
  onSelect: (sessionId: string | undefined) => void
}

// One card per agent session. A timed-out session carries a visible warning with its reason: the agent stopped
// without finishing, which a supervisor must notice without opening anything.
export function ActivitySessions({ sessions, total, now, selectedSessionId, onSelect }: ActivitySessionsProps) {
  return (
    <>
      <ul className="activity-sessions" aria-label="Sessions des agents">
        {sessions.map((session) => {
          const selected = session.id === selectedSessionId
          return (
            <li key={session.id} className={`activity-session is-${session.status}${selected ? ' is-selected' : ''}`}>
              <div className="activity-session__head">
                <span className="activity-session__agent">{session.agent_label}</span>
                <StatusBadge tone={SESSION_STATUS_TONES[session.status]}>
                  {SESSION_STATUS_LABELS[session.status]}
                </StatusBadge>
              </div>
              <dl className="activity-session__facts">
                <div>
                  <dt>Démarrée</dt>
                  <dd>
                    <time dateTime={session.started_at} title={absoluteMomentLabel(session.started_at)}>
                      {relativeMomentLabel(session.started_at, now)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Dernier signe</dt>
                  <dd>
                    <time dateTime={session.last_seen_at} title={absoluteMomentLabel(session.last_seen_at)}>
                      {relativeMomentLabel(session.last_seen_at, now)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Journal</dt>
                  <dd>{logsCountLabel(session.logs_count)}</dd>
                </div>
              </dl>
              {session.status === 'timed_out' && (
                <p className="activity-session__warning">
                  <AlertIcon size={16} />
                  <span>
                    Session expirée : {DISCONNECT_REASON_LABELS[session.disconnect_reason ?? 'inactivity_timeout']}.
                    L’agent a été déconnecté avant d’avoir terminé.
                  </span>
                </p>
              )}
              {session.status === 'ended' && session.disconnect_reason && (
                <p className="activity-session__reason">{DISCONNECT_REASON_LABELS[session.disconnect_reason]}</p>
              )}
              <Button
                size="sm"
                variant={selected ? 'primary' : 'secondary'}
                aria-pressed={selected}
                aria-label={`${selected ? 'Afficher tout le journal' : 'Filtrer le journal'} de ${session.agent_label}`}
                onClick={() => {
                  onSelect(selected ? undefined : session.id)
                }}
              >
                {selected ? 'Afficher tout le journal' : 'Filtrer le journal'}
              </Button>
            </li>
          )
        })}
      </ul>
      {total > sessions.length && (
        <p className="missions-muted">
          {String(sessions.length)} sessions affichées sur {String(total)} : affinez avec les filtres pour voir les
          autres.
        </p>
      )}
    </>
  )
}
