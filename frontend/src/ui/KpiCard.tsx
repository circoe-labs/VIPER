import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'

import type { IconComponent } from './icons'
import { InfoTip } from './InfoTip'
import './kpi-card.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

export type KpiTone = 'default' | 'info' | 'warning' | 'danger' | 'success'

// SIZE RULE: every KpiCard has the same height (--kpi-card-height, kpi-card.css) and its grid cell sets the width; the
// name (2 lines max), the figure and the chip line live inside that box and never resize it.
// The ONE counter card of the app (Prospection entities, Contact lists, CounterCards, Home): an icon tile on the left,
// the name and the big figure beside it, an optional chip next to the figure. Props:
//  - label    name of the counter
//  - icon     glyph of the tile
//  - value    undefined = loading (« … »), null = unavailable (« — »), else the figure
//  - weekly   chip « +N cette semaine » (undefined = hidden, null = « — » unavailable, number = shown)
//  - note     free chip text (e.g. « dont 3 en retard »), used when there is no weekly figure
//  - hint     one sentence explaining the counter, shown as a hover InfoTip in the corner
//  - active   the card is the one currently shown (aria-current for a link, aria-pressed for a button) + accent outline
//  - tone     colours the tile (and the figure when it asks something of the person): info, success, warning, danger
//  - to       renders a router <Link>; `onSelect` renders a toggle <button>; neither renders a plain <div>
export interface KpiCardProps {
  label: string
  icon: IconComponent
  value: number | string | null | undefined
  weekly?: number | null
  note?: ReactNode
  hint?: ReactNode
  active?: boolean
  tone?: KpiTone
  to?: string
  onSelect?: () => void
  className?: string
}

export function formatKpi(value: number | string | null | undefined): string {
  return value === undefined ? '…' : value === null ? '—' : typeof value === 'string' ? value : NUMBER.format(value)
}

export function KpiCard({ label, icon: Icon, value, weekly, note, hint, active = false, tone = 'default', to, onSelect, className }: KpiCardProps) {
  const classes = ['kpi-card', `kpi-card--${tone}`, active && 'is-active', (to || onSelect) && 'kpi-card--action', value === 0 && 'kpi-card--zero', className].filter(Boolean).join(' ')
  const body = (
    <>
      <span className="kpi-card__icon" aria-hidden="true"><Icon size={26} /></span>
      <span className="kpi-card__name" title={label}>{label}</span>
      <strong className="kpi-card__value">
        {formatKpi(value)}
        {value === null && <span className="visually-hidden"> indisponible</span>}
      </strong>
      {/* The chip line is ALWAYS rendered (empty when there is nothing to say): it reserves its height, so a card with
          a weekly figure and one without are exactly the same size. */}
      <span className="kpi-card__sub">
        {weekly !== undefined && (
          <span className={weekly === null ? 'kpi-card__chip kpi-card__chip--unknown' : 'kpi-card__chip'} title={weekly === null ? 'Ajouts de la semaine indisponibles' : undefined}>
            {weekly === null ? '—' : `+${NUMBER.format(weekly)} cette semaine`}
          </span>
        )}
        {weekly === undefined && note && <span className="kpi-card__chip kpi-card__chip--note">{note}</span>}
      </span>
    </>
  )
  // The hint sits OUTSIDE the link/button (an interactive control cannot nest another one), in the corner.
  const tip = hint ? <span className="kpi-card__tip"><InfoTip label={`Aide : ${label}`} size={14}>{hint}</InfoTip></span> : null
  return (
    <div className="kpi-card__slot">
      {to ? (
        <Link to={to} className={classes} aria-current={active ? 'page' : undefined}>{body}</Link>
      ) : onSelect ? (
        <button type="button" className={classes} aria-pressed={active} onClick={onSelect}>{body}</button>
      ) : (
        <div className={classes}>{body}</div>
      )}
      {tip}
    </div>
  )
}

// A row of equal KpiCards: `columns` sets how many sit side by side; narrower screens drop to 2 then 1 column (equal cells).
export function KpiGrid({ columns = 3, label, children }: { columns?: number; label: string; children: ReactNode }) {
  return (
    <section className="kpi-grid" aria-label={label} style={{ '--kpi-columns': columns } as CSSProperties}>
      {children}
    </section>
  )
}
