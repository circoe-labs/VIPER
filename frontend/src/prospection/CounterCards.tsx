import type { Counters, Segment } from '../api/prospection'
import { CheckIcon } from '../ui/icons'
import { SEGMENT_GROUPS, SEGMENT_INFO } from './labels'

interface CounterCardsProps {
  counters: Counters | undefined
  active: Segment
  onSelect: (segment: Segment) => void
}

const NUMBER = new Intl.NumberFormat('fr-FR')

// Actionable counters: every card is a toggle button that shows its segment in the list below (aria-pressed; the
// active one also carries a check mark and a stronger outline, never colour alone). Counts follow the current search
// and filters, so a card always equals the list it opens.
export function CounterCards({ counters, active, onSelect }: CounterCardsProps) {
  const stale = counters?.stale_threshold_days
  return (
    <section className="counters" aria-label="Compteurs">
      {SEGMENT_GROUPS.map((group) => (
        <div key={group.title} className="counters__group" role="group" aria-labelledby={`counters-${group.id}`}>
          <h2 id={`counters-${group.id}`} className="counters__title eyebrow">
            {group.title}
          </h2>
          <div className="counters__cards">
            {group.segments.map((segment) => {
              const { label, hint, icon: Icon } = SEGMENT_INFO[segment]
              const pressed = segment === active
              const count = counters?.counts[segment]
              return (
                <button
                  key={segment}
                  type="button"
                  className="counter-card"
                  aria-pressed={pressed}
                  title={hint}
                  onClick={() => {
                    onSelect(segment)
                  }}
                >
                  <span className="counter-card__label">
                    <Icon size={14} />
                    {label}
                  </span>
                  <span className="counter-card__count">{count === undefined ? '–' : NUMBER.format(count)}</span>
                  {pressed && (
                    <span className="counter-card__mark">
                      <CheckIcon size={14} />
                      <span className="visually-hidden">(affiché)</span>
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {group.id === 'verification' && counters && (
            <p className="counters__note">
              {stale === null
                ? 'Aucun seuil d’ancienneté configuré : « À revérifier » compte seulement les coordonnées remises à vérifier (changement d’entreprise).'
                : `« À revérifier » compte aussi les vérifications de plus de ${String(stale)} jours.`}
            </p>
          )}
        </div>
      ))}
    </section>
  )
}
