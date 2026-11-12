import type { ProposalItem } from '../api/agents'
import { StatusBadge } from '../ui/Badge'
import { ConfidenceBadge } from './ReviewConfidence'
import { formatSourceDate, isOldSource, safeHref, sourceHost } from './reviewFormat'

// What backs one proposed value: its confidence, its source, the source's own publication date and the date the agent
// checked it. Each missing piece is said out loud; a publication date is never replaced by the check date.
// Results stored before Slice 02 lack the confidence/date fields and read « non renseignée » / « date inconnue ».
export function ReviewEvidence({ item, showQuote = true }: { item: ProposalItem; showQuote?: boolean }) {
  const href = safeHref(item.source)
  const published = item.source_published_at ?? null
  const checked = item.source_checked_at ?? null
  return (
    <div className="review-evidence" role="group" aria-label={`Éléments de preuve : ${item.label}`}>
      <ConfidenceBadge value={item.confidence} />
      <span className="review-evidence__fact">
        <span className="review-evidence__term">Source</span>
        {href ? (
          <>
            <a href={href} target="_blank" rel="noreferrer noopener" title={href}>
              source
            </a>
            <span className="review-evidence__host">{sourceHost(href)}</span>
          </>
        ) : (
          <span className="review-evidence__missing">aucune source</span>
        )}
      </span>
      <span className="review-evidence__fact">
        <span className="review-evidence__term">Publiée</span>
        {published ? (
          <>
            <time dateTime={published}>{formatSourceDate(published)}</time>
            {isOldSource(published) && <StatusBadge tone="warning">ancienne</StatusBadge>}
          </>
        ) : (
          <span className="review-evidence__missing">date inconnue</span>
        )}
      </span>
      <span className="review-evidence__fact">
        <span className="review-evidence__term">Vérifiée</span>
        {checked ? (
          <time dateTime={checked}>{formatSourceDate(checked, true)}</time>
        ) : (
          <span className="review-evidence__missing">non datée</span>
        )}
      </span>
      {showQuote && item.quote && <q className="review-evidence__quote">{item.quote}</q>}
    </div>
  )
}
