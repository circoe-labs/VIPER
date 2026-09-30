import type { Counters, Segment } from '../api/prospection'
import { CounterCard, CounterGroup } from '../ui/CounterCards'
import { SEGMENT_GROUPS, SEGMENT_INFO } from './labels'

interface CounterCardsProps {
  counters: Counters | undefined
  active: Segment
  onSelect: (segment: Segment) => void
}

// Actionable counters of Prospection (shared card primitive: src/ui/CounterCards.tsx). Counts follow the current
// search and filters, so a card always equals the list it opens.
export function CounterCards({ counters, active, onSelect }: CounterCardsProps) {
  const stale = counters?.stale_threshold_days
  return (
    <section className="counters" aria-label="Compteurs">
      {SEGMENT_GROUPS.map((group) => (
        <CounterGroup
          key={group.id}
          id={group.id}
          title={group.title}
          note={
            group.id === 'verification' &&
            counters &&
            (stale === null
              ? 'Aucun seuil d’ancienneté configuré : « À revérifier » compte seulement les coordonnées remises à vérifier (changement d’entreprise).'
              : `« À revérifier » compte aussi les vérifications de plus de ${String(stale)} jours.`)
          }
        >
          {group.segments.map((segment) => {
            const { label, hint, icon } = SEGMENT_INFO[segment]
            return (
              <CounterCard
                key={segment}
                label={label}
                hint={hint}
                icon={icon}
                count={counters?.counts[segment]}
                pressed={segment === active}
                onSelect={() => {
                  onSelect(segment)
                }}
              />
            )
          })}
        </CounterGroup>
      ))}
    </section>
  )
}
