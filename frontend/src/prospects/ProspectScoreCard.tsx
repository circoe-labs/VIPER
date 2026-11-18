import { useState } from 'react'

import type { ProspectScore } from '../api/prospects'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, InfoIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { ScoreRing } from '../ui/ScoreRing'
import { EditorSection } from './EditorSection'
import { ScoreEvaluation } from './ScoreEvaluation'
import { assessmentProvenance, BAND_LABELS, BAND_TONES, contributionSource, signedDelta, sortContributions, sortCriteria } from './scoreView'
import './prospect-score.css'

interface ProspectScoreCardProps {
  // The prospect's score as the backend computed it; null = nothing to show (a prospect not saved yet).
  score: ProspectScore | null
  // The last refresh of the score failed: the figure shown may be out of date.
  outdated?: boolean
  // « Voir la note »: the editor shows the note on its tab.
  onShowNote: (noteId: string) => void
  // The saved prospect: enables « Évaluer » / « Réévaluer le score » (the AI scores the sheet directly, in seconds).
  // Absent = no evaluation affordance. Seam for ProspectEditor (S1): pass `prospect.id`.
  prospectId?: string | null
}

// « Score prospect » card (prospect-contact-ux S4), first KPI of the Profil tab. One fixed-height body (ScoreEvaluation) shows
// the score, or whichever async state « Évaluer le score » is in, in place; « Voir le détail » opens the detail in a modal dialog
// (focus trapped, Esc closes it alone, focus back on the button). The slot div stays when there is no score, and then takes no
// room (profile-summary.css).
export function ProspectScoreCard({ score, outdated = false, onShowNote, prospectId = null }: ProspectScoreCardProps) {
  return (
    <div className="prospect-score-slot" data-slot="prospect-score">
      {score && <ScoreSection score={score} outdated={outdated} onShowNote={onShowNote} prospectId={prospectId} />}
    </div>
  )
}

interface ScoreSectionProps {
  score: ProspectScore
  outdated: boolean
  onShowNote: (noteId: string) => void
  prospectId: string | null
}

function ScoreSection({ score, outdated, onShowNote, prospectId }: ScoreSectionProps) {
  const [open, setOpen] = useState(false)

  return (
    <EditorSection
      title="Score prospect"
      actions={
        <InfoTip label="Aide : Score prospect">
          Intérêt commercial du prospect pour Circoe, d’après ses critères et les signaux validés. Les relations n’y entrent pas.
        </InfoTip>
      }
    >
      {/* One body, always the same height: ring, level, detail link and every async state of « Évaluer » replace
          each other here (ScoreEvaluation.tsx); nothing is ever added around it. */}
      <ScoreEvaluation
        prospectId={prospectId}
        score={score}
        onOpenDetail={() => {
          setOpen(true)
        }}
      />
      {outdated && (
        <p className="prospect-score__outdated" role="status">
          <AlertIcon size={14} />
          Mise à jour impossible : ce score peut être périmé.
        </p>
      )}
      <ScoreDetail
        open={open}
        score={score}
        onClose={() => {
          setOpen(false)
        }}
        onShowNote={(noteId) => {
          setOpen(false)
          onShowNote(noteId)
        }}
      />
    </EditorSection>
  )
}

interface ScoreDetailProps {
  open: boolean
  score: ProspectScore
  onClose: () => void
  onShowNote: (noteId: string) => void
}

// The detail: the total and the rationale; with an AI assessment its criteria (signed impact, label, evidence) and where it
// comes from (model, prompt version, who, when); then the notes that carry points (sorted by scoreView.sortContributions).
function ScoreDetail({ open, score, onClose, onShowNote }: ScoreDetailProps) {
  const contributions = sortContributions(score.contributions)
  const assessment = score.assessment ?? null
  return (
    <Modal open={open} size="lg" title="Détail du score" onClose={onClose}>
      <div className="prospect-score-detail">
        <div className="prospect-score-detail__head">
          <ScoreRing value={score.total} tone={BAND_TONES[score.band]} size="lg" />
          <div className="prospect-score-detail__text">
            <p className="prospect-score-detail__total">
              <strong>{score.total}</strong> sur 100 · niveau {BAND_LABELS[score.band].toLowerCase()}
            </p>
            <p className="prospect-score-detail__summary">{score.summary}</p>
          </div>
        </div>
        {assessment && (
          <>
            <h3 className="prospect-score-detail__title">Critères de l’évaluation</h3>
            {assessment.criteria.length === 0 ? (
              <p className="prospect-score-detail__empty">
                <InfoIcon size={16} />
                L’IA n’a détaillé aucun critère.
              </p>
            ) : (
              <ul className="prospect-score-detail__list" aria-label="Critères de l’évaluation">
                {sortCriteria(assessment.criteria).map((criterion) => (
                  <li key={`${criterion.label}-${criterion.evidence}`} className="prospect-score-detail__item">
                    <span
                      className="prospect-score-detail__delta"
                      data-sign={Math.sign(criterion.delta)}
                      role="img"
                      aria-label={`${signedDelta(criterion.delta)} points`}
                    >
                      {signedDelta(criterion.delta)}
                    </span>
                    <div className="prospect-score-detail__body">
                      <p className="prospect-score-detail__reason">{criterion.label}</p>
                      <p className="prospect-score-detail__source">{criterion.evidence}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="prospect-editor__muted prospect-score-detail__provenance">{assessmentProvenance(assessment)}</p>
          </>
        )}
        <h3 className="prospect-score-detail__title">{assessment ? 'Notes avec points (hors évaluation de l’IA)' : 'Contributions'}</h3>
        {contributions.length === 0 ? (
          <p className="prospect-score-detail__empty">
            <InfoIcon size={16} />
            {assessment ? 'Aucune note ne porte de points.' : 'Aucun signal enregistré : le score est à sa valeur de départ.'}
          </p>
        ) : (
          <>
            <p className="prospect-editor__muted">Les plus favorables d’abord, puis les plus défavorables.</p>
            <ul className="prospect-score-detail__list" aria-label="Contributions au score">
              {contributions.map((contribution) => (
                <li key={contribution.id} className="prospect-score-detail__item">
                  <span
                    className="prospect-score-detail__delta"
                    data-sign={Math.sign(contribution.delta)}
                    role="img"
                    aria-label={`${signedDelta(contribution.delta)} points`}
                  >
                    {signedDelta(contribution.delta)}
                  </span>
                  <div className="prospect-score-detail__body">
                    <p className="prospect-score-detail__reason">{contribution.reason}</p>
                    <p className="prospect-score-detail__source">
                      {contributionSource(contribution)}
                      {contribution.source_type === 'note' && contribution.source_ref && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (contribution.source_ref) onShowNote(contribution.source_ref)
                          }}
                        >
                          Voir la note
                        </Button>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
