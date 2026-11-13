import type { ReactNode } from 'react'

import type { IconComponent } from '../ui/icons'
import type { MissionHue } from './missionAccent'
import './missionUi.css'

interface MissionKpiGridProps {
  // Names the group for assistive technology (« Indicateurs de la mission »).
  label: string
  children: ReactNode
}

// A row of KPI tiles. A description list: each tile is a term (label) and its figure.
export function MissionKpiGrid({ label, children }: MissionKpiGridProps) {
  return (
    <dl className="mui-kpis" aria-label={label}>
      {children}
    </dl>
  )
}

interface MissionKpiTileProps {
  label: string
  // number/string = the figure; undefined = still loading (« – »); null = not available from the API (« — »).
  // A real zero is a number and is shown as 0: only a counter that is proven to be zero may say 0.
  value: number | string | null | undefined
  icon?: IconComponent
  hue?: MissionHue
  // One short sentence under the figure (how it is computed, why it is unavailable).
  hint?: string
}

const NUMBER = new Intl.NumberFormat('fr-FR')

// KPI tile of the Mission screens (list header counters, statistics, detail). Presentational: the caller supplies the
// figure from an existing hook; this component never derives, defaults or invents one.
export function MissionKpiTile({ label, value, icon: Icon, hue = 'neutral', hint }: MissionKpiTileProps) {
  const loading = value === undefined
  const unavailable = value === null
  const shown = typeof value === 'number' ? NUMBER.format(value) : (value ?? (loading ? '–' : '—'))
  const note = hint ?? (unavailable ? 'Non disponible.' : undefined)
  return (
    <div className="mui-kpi" data-hue={hue} aria-busy={loading || undefined}>
      <dt className="mui-kpi__label">
        {Icon && (
          <span className="mui-kpi__icon" aria-hidden="true">
            <Icon size={18} />
          </span>
        )}
        {label}
      </dt>
      <dd className="mui-kpi__value">
        {shown}
        {loading && <span className="visually-hidden"> (chargement)</span>}
        {unavailable && <span className="visually-hidden"> (indisponible)</span>}
      </dd>
      {note && <dd className="mui-kpi__hint">{note}</dd>}
    </div>
  )
}
