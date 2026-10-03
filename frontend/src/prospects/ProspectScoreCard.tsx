import { type MouseEvent, useId, useState } from 'react'

import type { ProspectScore } from '../api/prospects'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, ChevronRightIcon, InfoIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { EditorSection } from './EditorSection'
import { BAND_LABELS, BAND_TONES, contributionSource, signedDelta, sortContributions } from './scoreView'
import './prospect-score.css'

interface ProspectScoreCardProps {
  // The prospect's score as the backend computed it; null = nothing to show (a prospect not saved yet).
  score: ProspectScore | null
  // The last refresh of the score failed: the figure shown may be out of date.
  outdated?: boolean
  // « Voir la note »: the editor shows the note on its tab.
  onShowNote: (noteId: string) => void
}

// « Score prospect » card (prospect-contact-ux S4), top of the Profil tab's right column. The whole summary is one
// button that opens the detail in a modal dialog (focus trapped, Esc closes it alone, focus back on the card). The
// slot div stays when there is no score, and then takes no room (profile-summary.css).
export function ProspectScoreCard({ score, outdated = false, onShowNote }: ProspectScoreCardProps) {
  return (
    <div className="prospect-score-slot" data-slot="prospect-score">
      {score && <ScoreSection score={score} outdated={outdated} onShowNote={onShowNote} />}
    </div>
  )
}

function scoreName(score: ProspectScore): string {
  return `${String(score.total)} sur 100, niveau ${BAND_LABELS[score.band].toLowerCase()}`
}

function ScoreSection({ score, outdated, onShowNote }: { score: ProspectScore; outdated: boolean; onShowNote: (noteId: string) => void }) {
  const [open, setOpen] = useState(false)
  const summaryId = useId()

  // Opened by a click: the card takes the focus itself (Safari does not focus a clicked button), so that the dialog
  // gives it back there.
  function show(event: MouseEvent<HTMLButtonElement>) {
    event.currentTarget.focus()
    setOpen(true)
  }

  return (
    <EditorSection title="Score prospect">
      <button
        type="button"
        className="prospect-score"
        data-band={score.band}
        aria-label={`Score prospect : ${scoreName(score)}. Voir le détail`}
        aria-describedby={summaryId}
        aria-haspopup="dialog"
        onClick={show}
      >
        <ScoreRing value={score.total} tone={BAND_TONES[score.band]} />
        <span className="prospect-score__text">
          <span className="prospect-score__band">{BAND_LABELS[score.band]}</span>
          <span id={summaryId} className="prospect-score__summary" title={score.summary}>
            {score.summary}
          </span>
          <span className="prospect-score__more">
            Voir le détail
            <ChevronRightIcon size={14} />
          </span>
        </span>
      </button>
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
