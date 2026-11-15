import type { ReactNode } from 'react'

import { ACTIVITY_EVENT_TYPES, type MissionStatistics } from '../api/missions'
import { AlertIcon, BoltIcon, ClockIcon, TerminalIcon } from '../ui/icons'
import type { IconComponent } from '../ui/icons'
import { MissionPanel } from './MissionPanel'
import type { MissionHue } from './missionAccent'
import { StatsChart } from './StatsChart'
import { useTableToggle } from './TableToggle'
import {
  bucketLongLabel,
  type ChartPoint,
  type ChartSeries,
  countPoints,
  formatCount,
  RESULT_SERIES,
  resultPoints,
} from './statsModel'
import { activityFigures, attentionFigures } from './statsSelectors'
import { EVENT_TYPE_COUNT_LABELS } from './vocabulary'
import './statsPanels.css'

const AVERAGE = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

function average(value: number | null): string {
  return value === null ? '—' : AVERAGE.format(value)
}

interface ChartPanelProps {
  stats: MissionStatistics
  title: string
  icon: IconComponent
  hue: MissionHue
  id: string
  series: ChartSeries[]
  points: ChartPoint[]
  children?: ReactNode
}

function ChartPanel({ stats, title, icon, hue, id, series, points, children }: ChartPanelProps) {
  const { asTable, button } = useTableToggle()
  return (
    <MissionPanel title={title} icon={icon} hue={hue} actions={button}>
      {children}
      <StatsChart id={id} title={title} series={series} points={points} bucket={stats.bucket} hideTitle asTable={asTable} />
    </MissionPanel>
  )
}

// « Activité des agents »: journal entries per UTC bucket (`logs_series`, zero-filled). Replaces the reference's
// « Appels API » area chart: the unit is journal entries because no call counter exists (CONTRACT.md D3).
export function ActivityChartPanel({ stats }: { stats: MissionStatistics }) {
  const figures = activityFigures(stats)
  return (
    <ChartPanel
      stats={stats}
      title="Activité des agents (entrées de journal)"
      icon={TerminalIcon}
      hue="purple"
      id="stats-logs"
      series={[{ key: 'count', label: 'Journaux', tone: 'info' }]}
      points={countPoints(stats.logs_series)}
    >
      <dl className="stp-figures">
        <div>
          <dt>entrées au total</dt>
          <dd>{formatCount(figures.logs)}</dd>
        </div>
        <div>
          <dt>par agent (moy.)</dt>
          <dd>{average(figures.logsPerAgent)}</dd>
        </div>
      </dl>
    </ChartPanel>
  )
}

export function ResultsSeriesPanel({ stats }: { stats: MissionStatistics }) {
  return (
    <ChartPanel
      stats={stats}
      title="Résultats déposés"
      icon={BoltIcon}
      hue="green"
      id="stats-results"
      series={RESULT_SERIES}
      points={resultPoints(stats)}
    />
  )
}

export function SessionsSeriesPanel({ stats }: { stats: MissionStatistics }) {
  return (
    <ChartPanel
      stats={stats}
      title="Sessions démarrées"
      icon={ClockIcon}
      hue="teal"
      id="stats-sessions"
      series={[{ key: 'count', label: 'Sessions', tone: 'accent' }]}
      points={countPoints(stats.sessions_series)}
    />
  )
}

interface RowProps {
  label: string
  value: string
  note?: string
  tone?: 'danger' | 'warning'
  zero?: boolean
}

function Row({ label, value, note, tone, zero }: RowProps) {
  const toned = tone && !zero
  return (
    <div className="stp-row" data-tone={toned ? tone : undefined}>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {note && <span className="stp-row__note">{note}</span>}
      </dd>
    </div>
  )
}

// « Analyse de l'activité » (replaces the reference's « Analyse temporelle »): volume figures derived from exact
// counters. No processing time, no calls per minute: neither is recorded.
export function ActivityAnalysisPanel({ stats }: { stats: MissionStatistics }) {
  const figures = activityFigures(stats)
  const sessions = stats.sessions_by_status
  return (
    <MissionPanel title="Analyse de l’activité" icon={ClockIcon} hue="amber">
      <dl className="stp-rows">
        <Row
          label="Sessions"
          value={formatCount(figures.sessions)}
          note={`${formatCount(sessions.active)} active(s)`}
        />
        <Row label="Journaux" value={formatCount(figures.logs)} />
        <Row label="Sources ouvertes" value={formatCount(stats.logs_by_event_type.source_opened)} />
        <Row label="Journaux par session (moy.)" value={average(figures.logsPerSession)} />
        <Row
          label="Pic d’activité (UTC)"
          value={figures.peak ? `${formatCount(figures.peak.count)} entrées` : '—'}
          note={
            figures.peak ? bucketLongLabel(figures.peak.bucket, stats.bucket) : 'Aucune entrée sur la période.'
          }
        />
      </dl>
    </MissionPanel>
  )
}

// « Points d'attention »: where it went wrong or waited. Exact counts of existing rows (a zero is a proven zero).
export function AttentionPanel({ stats }: { stats: MissionStatistics }) {
  const figures = attentionFigures(stats)
  return (
    <MissionPanel title="Erreurs et attentes" icon={AlertIcon} hue="neutral">
      <dl className="stp-rows">
        <Row label="Erreurs signalées" value={formatCount(figures.errors)} tone="danger" zero={figures.errors === 0} />
        <Row
          label="Avertissements"
          value={formatCount(figures.warnings)}
          tone="warning"
          zero={figures.warnings === 0}
        />
        <Row
          label="Tâches en échec"
          value={formatCount(figures.failedTasks)}
          tone="danger"
          zero={figures.failedTasks === 0}
        />
        <Row
          label="Sessions expirées"
          value={formatCount(figures.timedOutSessions)}
          tone="warning"
          zero={figures.timedOutSessions === 0}
        />
      </dl>
    </MissionPanel>
  )
}

// Journal entries per event type (`logs_by_event_type`): 8 categories, so bars rather than a donut (> 6 segments).
export function EventBreakdownPanel({ stats }: { stats: MissionStatistics }) {
  const values = stats.logs_by_event_type
  const peak = Math.max(1, ...ACTIVITY_EVENT_TYPES.map((type) => values[type]))
  return (
    <MissionPanel title="Journaux par type d’événement" icon={TerminalIcon} hue="blue">
      <ul className="stp-events">
        {ACTIVITY_EVENT_TYPES.map((type) => (
          <li key={type} className="stp-events__row">
            <span className="stp-events__label">{EVENT_TYPE_COUNT_LABELS[type]}</span>
            <span className="stp-events__bar" aria-hidden="true">
              <i style={{ width: `${String((values[type] / peak) * 100)}%` }} />
            </span>
            <span className="stp-events__count">{formatCount(values[type])}</span>
          </li>
        ))}
      </ul>
    </MissionPanel>
  )
}
