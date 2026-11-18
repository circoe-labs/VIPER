import type { ProfileCompleteness, ProfileCompletenessCriterion } from '../api/profileCompleteness'
import { StatusBadge } from '../ui/Badge'
import { AlertIcon, CheckCircleIcon, InfoIcon, MinusCircleIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { COMPLETENESS_STEP_COUNT, completenessStep, completenessTone, CRITERION_STATUS_LABELS, splitCriteria } from './completenessView'
import { EditorSection } from './EditorSection'
import './profile-completeness.css'

interface DataQualityCardProps {
  // The backend's fiche completeness; null = not saved yet (nothing to show) unless `discarded`/`unavailable` say why.
  quality: ProfileCompleteness | null
  // True for a prospect under durable opposition: the card says so instead of showing a state.
  discarded?: boolean
  // The completeness could not be loaded: said explicitly instead of silently showing nothing.
  unavailable?: boolean
}

const TITLE = 'Qualité de la fiche'

function CriterionList({ title, items }: { title: string; items: ProfileCompletenessCriterion[] }) {
  if (items.length === 0) return null
  return (
    <ul className="completeness__list" aria-label={title}>
      {items.map((criterion) => (
        <li key={criterion.id} className="completeness__item" data-status={criterion.status}>
          {criterion.status === 'met' ? <CheckCircleIcon size={14} /> : criterion.status === 'partial' ? <AlertIcon size={14} /> : <MinusCircleIcon size={14} />}
          <span>
            <strong>{criterion.label}</strong> · {criterion.detail}
            <span className="visually-hidden"> ({CRITERION_STATUS_LABELS[criterion.status]})</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

// « Qualité de la fiche » card (the fiche completeness state) (Profil tab): a named state (Incomplète / Exploitable / Fournie / Très fournie), what
// it means (tooltip), what is missing (summary) and the criteria in a disclosure. Computed deterministically by the
// backend; the UI never shows a number. The state is a word + glyph + a 4-step meter, so colour is never the only signal.
export function DataQualityCard({ quality, discarded = false, unavailable = false }: DataQualityCardProps) {
  if (discarded) {
    return (
      <EditorSection title={TITLE}>
        <p className="prospect-score-detail__empty">
          <InfoIcon size={16} />
          Écarté : pas d'évaluation pour un prospect en opposition.
        </p>
      </EditorSection>
    )
  }
  if (!quality) {
    if (!unavailable) return null
    return (
      <EditorSection title={TITLE}>
        <p className="prospect-score-detail__empty" role="alert">
          <AlertIcon size={16} />
          Complétude indisponible : rechargez la fiche pour la recalculer.
        </p>
      </EditorSection>
    )
  }
  const step = completenessStep(quality.state)
  const { todo, done } = splitCriteria(quality)
  return (
    <EditorSection title={TITLE}>
      <div className="completeness" data-state={quality.state}>
        <div className="completeness__head">
          <StatusBadge tone={completenessTone(quality.state)} strong={quality.state === 'incomplete'}>
            {quality.state_label}
          </StatusBadge>
          <InfoTip label={`Aide : fiche ${quality.state_label.toLowerCase()}`}>{quality.state_description}</InfoTip>
          {step > 0 && (
            <span className="completeness__meter" aria-hidden="true">
              {Array.from({ length: COMPLETENESS_STEP_COUNT }, (_, index) => (
                <span key={index} className="completeness__step" data-on={index < step} />
              ))}
            </span>
          )}
        </div>
        <p className="completeness__summary">{quality.summary}</p>
        {quality.criteria.length > 0 && (
          <details className="completeness__details">
            <summary>Voir les critères</summary>
            <CriterionList title="Critères à compléter" items={todo} />
            <CriterionList title="Critères acquis" items={done} />
          </details>
        )}
      </div>
    </EditorSection>
  )
}
