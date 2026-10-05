import type { ReactNode } from 'react'

import { CheckIcon, type IconComponent } from './icons'
import './counter-cards.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

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
  // What the counter counts, in one sentence (tooltip).
  hint: string
  icon: IconComponent
  // Undefined while loading (shown « – »).
  count: number | undefined
  pressed: boolean
  onSelect: () => void
  // What the figure asks of the person: `attention` = something to fix (amber), `go` = something to do now (green).
  // Untoned counters are context and stay quiet.
  tone?: 'attention' | 'go'
}

// An actionable counter: a toggle button that shows its segment in the list below (aria-pressed; the pressed one also
// carries a check mark and a stronger outline, never colour alone). A card always equals the list it opens.
export function CounterCard({ label, hint, icon: Icon, count, pressed, onSelect, tone }: CounterCardProps) {
  const lit = tone && count !== undefined && count > 0
  const classes = ['counter-card', lit && `counter-card--${tone}`, count === 0 && 'counter-card--zero']
  return (
    <button type="button" className={classes.filter(Boolean).join(' ')} aria-pressed={pressed} title={hint} onClick={onSelect}>
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
}
