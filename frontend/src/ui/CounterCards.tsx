import type { ReactNode } from 'react'

import type { IconComponent } from './icons'
import { KpiCard } from './KpiCard'
import './counter-cards.css'

interface CounterGroupProps {
  id: string
  title: string
  // A remark under the cards (e.g. how a counter is computed).
  note?: ReactNode
  className?: string
  children: ReactNode
}

// One eyebrow-titled group of counter cards (a named `group`); the page wraps its groups in `<section className=
// "counters" aria-label="Compteurs">`.
export function CounterGroup({ id, title, note, className, children }: CounterGroupProps) {
  const titleId = `counters-${id}`
  return (
    <div className={['counters__group', className].filter(Boolean).join(' ')} role="group" aria-labelledby={titleId}>
      <h2 id={titleId} className="counters__title eyebrow">
        {title}
      </h2>
      <div className="counters__cards">{children}</div>
      {note && <p className="counters__note">{note}</p>}
    </div>
  )
}

interface CounterCardProps {
  label: string
  // What the counter counts, in one sentence (hover tooltip).
  hint: string
  icon: IconComponent
  // Undefined while loading (shown « … »).
  count: number | undefined
  pressed: boolean
  onSelect: () => void
  // What the figure asks of the person: `attention` = something to fix (amber), `go` = something to do now (green).
  tone?: 'attention' | 'go'
}

// An actionable counter: a toggle button that shows its segment in the list below (aria-pressed). A card always equals
// the list it opens. It is the shared KpiCard (ui/KpiCard.tsx), so it looks like every other counter of the app.
export function CounterCard({ label, hint, icon, count, pressed, onSelect, tone }: CounterCardProps) {
  return <KpiCard label={label} hint={hint} icon={icon} value={count} active={pressed} onSelect={onSelect} tone={tone === 'attention' ? 'warning' : tone === 'go' ? 'success' : 'default'} />
}
