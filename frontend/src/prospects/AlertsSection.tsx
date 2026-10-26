import { useState } from 'react'

import { type QualityAlert, useProspectAlerts, useSequenceMutations } from '../api/sequences'
import { formatDay } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, ChevronDownIcon, SparklesIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import { ConfirmActionDialog } from './SequenceDialogs'
import { ALERT_TYPE_LABELS, alertSourceLabel, conflictLines, sequenceRefusal } from './sequenceModel'
import './sequence.css'

interface AlertsSectionProps {
  prospectId: string
  onChanged?: () => void
}

// Alertes qualité (D8): signals on the data — never a change of state, cohort or sequence. Open ones first, with who
// raised them (a person, an import, or the AI as a proposal to review) and, for an import conflict, what was compared
// and where the file said it; a person resolves them. Resolved ones stay readable on demand.
export function AlertsSection({ prospectId, onChanged }: AlertsSectionProps) {
  const query = useProspectAlerts(prospectId)
  const { resolveAlert } = useSequenceMutations(prospectId)
  const [resolving, setResolving] = useState<QualityAlert | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const alerts = query.data?.items ?? []
  const open = alerts.filter((alert) => alert.open)
  const resolved = alerts.filter((alert) => !alert.open)

  async function resolve(alert: QualityAlert, note: string | null) {
    setError(null)
    try {
      await resolveAlert.mutateAsync({ id: alert.id, note })
      setResolving(null)
      onChanged?.()
    } catch (caught) {
      setError(sequenceRefusal(caught).message)
    }
  }

  return (
    <EditorSection title="Alertes qualité" count={open.length} tone={open.length > 0 ? 'warning' : undefined}>
      {query.isError && (
        <p className="prospect-editor__note prospect-editor__note--danger" role="alert">
          <AlertIcon size={16} />
          Alertes indisponibles.
        </p>
      )}
      {query.data && open.length === 0 && <p className="sequence-facts__hint">Aucune alerte ouverte.</p>}
      {open.length > 0 && (
        <ul className="alert-list" aria-label="Alertes ouvertes">
          {open.map((alert) => (
            <AlertItem
              key={alert.id}
              alert={alert}
              onResolve={() => {
                setError(null)
                resolveAlert.reset()
                setResolving(alert)
              }}
            />
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showResolved}
            onClick={() => {
              setShowResolved(!showResolved)
            }}
          >
            {showResolved ? 'Masquer' : 'Voir'} les alertes résolues ({resolved.length})
            <ChevronDownIcon size={16} className={showResolved ? 'alert-list__chevron--open' : undefined} />
          </Button>
          {showResolved && (
            <ul className="alert-list" aria-label="Alertes résolues">
              {resolved.map((alert) => (
                <AlertItem key={alert.id} alert={alert} />
              ))}
            </ul>
          )}
        </div>
      )}
      {resolving && (
        <ConfirmActionDialog
          title={`Résoudre « ${ALERT_TYPE_LABELS[resolving.type]} » ?`}
          lines={[
            resolving.type === 'email_error'
              ? 'Le prospect revient dans les actions automatiques (si sa séquence le permet). Enregistrez d’abord la nouvelle adresse e-mail et changez de cohorte.'
              : 'L’alerte passe dans les alertes résolues ; rien d’autre ne change sur la fiche.',
          ]}
          note
          confirmLabel="Résoudre l’alerte"
          busy={resolveAlert.isPending}
          error={error}
          pending={null}
          onClose={() => {
            setResolving(null)
          }}
          onConfirm={(note) => void resolve(resolving, note)}
        />
      )}
    </EditorSection>
  )
}

function AlertItem({ alert, onResolve }: { alert: QualityAlert; onResolve?: () => void }) {
  const lines = conflictLines(alert.detail)
  const proposal = alert.source === 'ai'
  return (
    <li className="alert-item" data-open={alert.open ? '' : undefined}>
      <div className="alert-item__head">
        <StatusBadge tone={alert.open ? (alert.type === 'email_error' ? 'danger' : 'warning') : 'neutral'}>
          {ALERT_TYPE_LABELS[alert.type]}
        </StatusBadge>
        {proposal ? (
          <StatusBadge tone="info" icon={SparklesIcon}>
            Proposition de l’IA
          </StatusBadge>
        ) : (
          <span className="alert-item__meta">{alertSourceLabel(alert.source, alert.raised_by)}</span>
        )}
        <span className="alert-item__meta">le {formatDay(alert.raised_at)}</span>
      </div>
      {alert.note && <p className="alert-item__note">{alert.note}</p>}
      {lines.length > 0 && (
        <dl className="alert-item__detail">
          {lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {proposal && alert.open && (
        <p className="alert-item__meta">L’IA ne décide rien : cette proposition n’a aucun effet tant qu’une personne ne la confirme pas.</p>
      )}
      {alert.open ? (
        onResolve && (
          <div>
            <Button size="sm" icon={CheckCircleIcon} onClick={onResolve}>
              Résoudre…
            </Button>
          </div>
        )
      ) : (
        <p className="alert-item__meta">
          Résolue{alert.resolved_at ? ` le ${formatDay(alert.resolved_at)}` : ''}
          {alert.resolved_by ? ` par ${alert.resolved_by}` : ''}
          {alert.resolution_note ? ` — ${alert.resolution_note}` : ''}
        </p>
      )}
    </li>
  )
}
