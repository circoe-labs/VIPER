import type { MissionResultCard } from '../api/missions'
import { ConfidenceBadge } from '../agents/ReviewConfidence'
import { TASK_TYPE_LABELS, sinceLabel } from '../agents/labels'
import { StatusBadge } from '../ui/Badge'
import { RESULT_STATUS_TONES, plural } from './resultsLabels'
import { RESULT_STATUS_LABELS } from './vocabulary'

// One result of the review queue: enough to decide what to open first (who, what, how sure, how big, how old).
// The whole card is the button that opens the validation dialog; the full proposal is read there, not here.
export function ResultsCard({ card, onOpen }: { card: MissionResultCard; onOpen: (id: string) => void }) {
  const decided = card.decided_at ? sinceLabel(card.decided_at) : null
  return (
    <button
      type="button"
      className="result-card"
      aria-haspopup="dialog"
      onClick={() => {
        onOpen(card.id)
      }}
    >
      <span className="result-card__head">
        <span className="result-card__title">
          {TASK_TYPE_LABELS[card.task_type]}
          {card.subject_label && <span className="result-card__subject"> — {card.subject_label}</span>}
        </span>
        <StatusBadge tone={RESULT_STATUS_TONES[card.status]} strong={card.status === 'pending_review'}>
          {RESULT_STATUS_LABELS[card.status]}
        </StatusBadge>
      </span>
      {card.summary ? (
        <span className="result-card__summary">{card.summary}</span>
      ) : (
        <span className="result-card__summary result-card__summary--empty">Aucun résumé fourni par l’agent.</span>
      )}
      <span className="result-card__facts">
        <ConfidenceBadge value={card.confidence} />
        <span>{plural(card.items_count, 'proposition', 'propositions')}</span>
        <span>{plural(card.refused_count, 'écartée', 'écartées')}</span>
        <span>{plural(card.sources_count, 'source', 'sources')}</span>
      </span>
      <span className="result-card__meta">
        <span>{card.agent_label}</span>
        <time dateTime={card.submitted_at} title={new Date(card.submitted_at).toLocaleString('fr-FR')}>
          soumis {sinceLabel(card.submitted_at)}
        </time>
        {decided && <span>décidé {decided}</span>}
      </span>
    </button>
  )
}
