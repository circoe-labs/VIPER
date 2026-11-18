import { useState } from 'react'

import type { ProspectScore } from '../api/prospects'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, InfoIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { EditorSection } from './EditorSection'
import { ScoreReassessment } from './ScoreReassessment'
import { BAND_LABELS, BAND_TONES, contributionSource, signedDelta, sortContributions } from './scoreView'
import './prospect-score.css'

interface ProspectScoreCardProps {
  // The prospect's score as the backend computed it; null = nothing to show (a prospect not saved yet).
  score: ProspectScore | null
  // The last refresh of the score failed: the figure shown may be out of date.
  outdated?: boolean
  // « Voir la note »: the editor shows the note on its tab.
  onShowNote: (noteId: string) => void
  // The saved prospect: enables « Évaluer » / « Réévaluer le score » (agent proposal, applied only once the person validates it).
  // Absent = no reassessment affordance. Seam for ProspectEditor (S1): pass `prospect.id`.
  prospectId?: string | null
  // A proposal was applied: the score changed, the editor may re-read what depends on it.
  onScoreChanged?: () => void
}

// « Score prospect » card (prospect-contact-ux S4), first KPI of the Profil tab. One fixed-height body (ScoreReassessment) shows
// the score, or whichever async state « Réévaluer le score » is in, in place; « Voir le détail » opens the detail in a modal dialog
// (focus trapped, Esc closes it alone, focus back on the button). The slot div stays when there is no score, and then takes no
// room (profile-summary.css).
export function ProspectScoreCard({ score, outdated = false, onShowNote, prospectId = null, onScoreChanged }: ProspectScoreCardProps) {
  return (
    <div className="prospect-score-slot" data-slot="prospect-score">
      {score && <ScoreSection score={score} outdated={outdated} onShowNote={onShowNote} prospectId={prospectId} onScoreChanged={onScoreChanged} />}
    </div>
  )
}

interface ScoreSectionProps {
  score: ProspectScore
  outdated: boolean
  onShowNote: (noteId: string) => void
  prospectId: string | null
  onScoreChanged?: () => void
}

function ScoreSection({ score, outdated, onShowNote, prospectId, onScoreChanged }: ScoreSectionProps) {
  const [open, setOpen] = useState(false)

  return (
    <EditorSection title="Score prospect">
      {/* One body, always the same height: ring, level, detail link and every async state of « Réévaluer » replace
          each other here (ScoreReassessment.tsx); nothing is ever added around it. */}
      <ScoreReassessment
        prospectId={prospectId}
        score={score}
        onScoreChanged={onScoreChanged}
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

// The detail: the total, the summary, then the contributions (sorted by scoreView.sortContributions) with their signed
// delta, reason and source.
function ScoreDetail({ open, score, onClose, onShowNote }: ScoreDetailProps) {
  const contributions = sortContributions(score.contributions)
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
        <h3 className="prospect-score-detail__title">Contributions</h3>
        {contributions.length === 0 ? (
          <p className="prospect-score-detail__empty">
            <InfoIcon size={16} />
            Aucun signal enregistré : le score est à sa valeur de départ.
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
