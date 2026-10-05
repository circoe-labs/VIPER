import { type Review, REVIEWS, type Counters } from '../api/prospection'
import { isoWeekOf, mondayLabel } from '../lib/isoWeek'
import { AlertIcon, ArrowUpIcon, BanIcon, CheckCircleIcon, CheckIcon, type IconComponent } from '../ui/icons'
import { REVIEW_INFO } from './labels'
import './review.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const PERCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 })

const ICONS: Record<Review, IconComponent> = {
  verified: CheckCircleIcon,
  to_verify: AlertIcon,
  ignored: BanIcon,
}

interface ReviewPanelsProps {
  counters: Counters | undefined
  active: Review | null
  // The pressed panel is pressed again: back to everyone (null).
  onSelect: (review: Review | null) => void
}

// The three readings of the base — verified, to verify, ignored — each with its size and what arrived since Monday
// (« 362 +14 »). A panel is a filter: it opens its people below, and its figures follow the search and filters.
export function ReviewPanels({ counters, active, onSelect }: ReviewPanelsProps) {
  const reviews = counters?.reviews
  const whole = reviews ? REVIEWS.reduce((sum, review) => sum + reviews[review].total, 0) : 0
  const week = counters ? isoWeekOf(counters.today) : null
  return (
    <section className="review" aria-labelledby="review-title">
      <div className="review__head">
        <h2 id="review-title" className="eyebrow">
          Vérification de la base
        </h2>
        {week && (
          <p className="review__week">
            Semaine {week.week} <span aria-hidden="true">·</span> depuis le {mondayLabel(week)}
          </p>
        )}
      </div>
      <div className="review__panels">
        {REVIEWS.map((review) => {
          const { label, caption, hint, weekHint } = REVIEW_INFO[review]
          const Icon = ICONS[review]
          const figures = reviews?.[review]
          const share = figures && whole > 0 ? figures.total / whole : 0
          const pressed = review === active
          return (
            <button
              key={review}
              type="button"
              className={`review-panel review-panel--${review}`}
              aria-pressed={pressed}
              title={hint}
              aria-label={
                figures
                  ? `${label} : ${NUMBER.format(figures.total)}, dont ${NUMBER.format(figures.week)} cette semaine`
                  : label
              }
              onClick={() => {
                onSelect(pressed ? null : review)
              }}
            >
              <span className="review-panel__label">
                <span className="review-panel__icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                {label}
                {pressed && (
                  <span className="review-panel__mark" aria-hidden="true">
                    <CheckIcon size={14} />
                  </span>
                )}
              </span>
              <span className="review-panel__figures">
                <span className="review-panel__count">{figures ? NUMBER.format(figures.total) : '–'}</span>
                {figures && (
                  <span
                    className={`review-panel__delta${figures.week === 0 ? ' review-panel__delta--zero' : ''}`}
                    title={`${NUMBER.format(figures.week)} ${weekHint}`}
                  >
                    <ArrowUpIcon size={12} />
                    <span>+{NUMBER.format(figures.week)}</span>
                    <span className="review-panel__delta-unit"> cette semaine</span>
                  </span>
                )}
              </span>
              <span className="review-panel__caption">{caption}</span>
              <span className="review-panel__share">
                <span className="review-panel__bar" aria-hidden="true">
                  <span style={{ width: PERCENT.format(share) }} />
                </span>
                <span>{figures ? `${PERCENT.format(share)} de la base` : ' '}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
