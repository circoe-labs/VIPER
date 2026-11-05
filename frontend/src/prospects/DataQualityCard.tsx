import { useId } from 'react'

import type { DataQualityScore } from '../api/prospects'
import { InfoIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { EditorSection } from './EditorSection'
import { BAND_TONES, DATA_QUALITY_LABELS } from './scoreView'
import './prospect-score.css'

interface DataQualityCardProps {
  // The backend's « Qualité de la fiche »; null = under durable opposition (« Écarté ») or not saved yet.
  quality: DataQualityScore | null
  // True for a prospect under durable opposition: the card says so instead of showing a score.
  discarded?: boolean
}

// « Qualité de la fiche » card (Profil tab, right column, under the interest score): how reachable and trustworthy the
// record is. Computed by the backend; the band decides the colour, the word and the figure carry it too. The criteria
// open in place (native disclosure), each with its points, so the user sees what to fix.
export function DataQualityCard({ quality, discarded = false }: DataQualityCardProps) {
  const listId = useId()
  if (discarded) {
    return (
      <EditorSection title="Qualité de la fiche">
        <p className="prospect-score-detail__empty">
          <InfoIcon size={16} />
          Écarté : pas de score pour un prospect en opposition.
        </p>
      </EditorSection>
    )
  }
  if (!quality) return null
  const label = DATA_QUALITY_LABELS[quality.band]
  return (
    <EditorSection title="Qualité de la fiche">
      <div className="data-quality" data-band={quality.band}>
        <div className="data-quality__head">
          <ScoreRing value={quality.total} tone={BAND_TONES[quality.band]} />
          <span className="prospect-score__text">
            <span className="prospect-score__band">
              {label}
              <span className="visually-hidden"> : {quality.total} sur 100</span>
            </span>
            <span className="prospect-score__summary">{quality.summary}</span>
          </span>
        </div>
        {quality.criteria.length > 0 && (
          <details className="data-quality__details">
            <summary>Voir les critères</summary>
            <ul id={listId} className="data-quality__list" aria-label="Critères de qualité de la fiche">
              {quality.criteria.map((criterion) => (
                <li key={criterion.id} className="data-quality__item" data-met={criterion.points === criterion.max_points}>
                  <span className="data-quality__points">
                    {criterion.points}/{criterion.max_points}
                  </span>
                  <span>
                    <strong>{criterion.label}</strong> · {criterion.detail}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </EditorSection>
  )
}
