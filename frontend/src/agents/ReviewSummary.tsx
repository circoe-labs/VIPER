import type { ResultView } from '../api/agents'
import { ScoreRing } from '../ui/ScoreRing'
import { CONFIDENCE_BAND_LABELS, CONFIDENCE_RING_TONES, confidenceBand } from './reviewFormat'

// Top of the review: the global confidence first (what a reviewer reads to decide how closely to look), then the
// volume of what is proposed, then the agent's research report. Reads only `proposal` + `raw`, so it works for
// historical results.
export function ReviewSummary({ result, sources }: { result: ResultView; sources: number }) {
  const { proposal } = result
  const band = confidenceBand(proposal.confidence)
  const hasConfidence = band !== 'unknown'
  // Slice 04: the agent's research report is the result `notes`. Older proposals carry it only in the raw payload.
  const rawNotes = result.raw.notes
  const report = (proposal.notes ?? (typeof rawNotes === 'string' ? rawNotes : '')).trim()
  return (
    <section className="review-summary" aria-label="Synthèse du résultat">
      <div className="review-summary__confidence">
        {hasConfidence && <ScoreRing value={proposal.confidence} tone={CONFIDENCE_RING_TONES[band]} size="lg" />}
        <div>
          <p className="review-summary__label">Confiance globale</p>
          <p className="review-summary__value">
            {hasConfidence
              ? `${CONFIDENCE_BAND_LABELS[band]} — ${String(Math.round(proposal.confidence))} sur 100`
              : 'Non renseignée'}
          </p>
        </div>
      </div>
      <ul className="review-summary__counts" aria-label="Volume du résultat">
        <li>
          <strong>{String(proposal.items.length)}</strong> proposition{proposal.items.length > 1 ? 's' : ''}
        </li>
        <li>
          <strong>{String(proposal.refused.length)}</strong> écartée{proposal.refused.length > 1 ? 's' : ''}
        </li>
        <li>
          <strong>{String(sources)}</strong> source{sources > 1 ? 's' : ''}
        </li>
      </ul>
      <div className="review-summary__report">
        <h3 className="review-summary__heading">Rapport de recherche de l’agent</h3>
        {report ? (
          <p>{report}</p>
        ) : (
          <p className="agents-muted">L’agent n’a fourni aucun rapport de recherche.</p>
        )}
      </div>
    </section>
  )
}
