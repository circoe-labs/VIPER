import { type ReactNode, useState } from 'react'

import type { ConversionTotals, WeeklySeries, WeekPoint } from '../api/metrics'
import { Card } from '../ui/Card'
import { InfoTip } from '../ui/InfoTip'
import { LineChart } from './LineChart'
import { StackedBars, type BarColumn, type BarSeries } from './StackedBars'
import { PieChart } from './PieChart'
import { percent, ratio, shortWeek, weekRange, weekStartLabel } from './weekBars'
import './home-charts.css'
import './home-charts-extra.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

const columnsOf = (weeks: WeekPoint[]): BarColumn[] => weeks.map((week) => ({ label: shortWeek(week.week), title: weekRange(week) }))
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

interface LegendItem { key: string; label: string; color: string; total: number }

// With `hidden` + `onToggle` the entries are buttons that show / hide their series.
function Legend({ items, hidden, onToggle }: { items: LegendItem[]; hidden?: ReadonlySet<string>; onToggle?: (key: string) => void }) {
  return (
    <ul className="chart-legend">
      {items.map((item) => {
        const content = (
          <>
            <span className="chart-legend__swatch" style={{ background: item.color }} aria-hidden="true" />
            {item.label}
            <strong>{NUMBER.format(item.total)}</strong>
          </>
        )
        const off = hidden?.has(item.key) ?? false
        return (
          <li key={item.key}>
            {onToggle ? (
              <button
                type="button"
                className={`chart-legend__toggle${off ? ' is-off' : ''}`}
                aria-pressed={!off}
                title={off ? `Afficher ${item.label}` : `Masquer ${item.label}`}
                onClick={() => {
                  onToggle(item.key)
                }}
              >
                {content}
              </button>
            ) : content}
          </li>
        )
      })}
    </ul>
  )
}

function ChartCard({ title, tip, children, className }: { title: string; tip: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={`home-chart${className ? ` ${className}` : ''}`} title={title} actions={<InfoTip label={`Définition : ${title}`}>{tip}</InfoTip>}>
      {children}
    </Card>
  )
}

function ActivityChart({ weeks }: { weeks: WeekPoint[] }) {
  const series: BarSeries[] = [
    { key: 'contacts', label: 'Contacts', color: 'var(--color-info-fg)', values: weeks.map((week) => week.first_contacts) },
    { key: 'follow_ups', label: 'Relances', color: 'var(--color-violet-fg)', values: weeks.map((week) => week.follow_ups) },
    { key: 'appointments', label: 'Rendez-vous', color: 'var(--color-warning-fg)', values: weeks.map((week) => week.appointments) },
    { key: 'ignored', label: 'Ignorés', color: 'var(--color-danger-fg)', values: weeks.map((week) => week.ignored) },
  ]
  const empty = series.every((entry) => sum(entry.values) === 0)
  return (
    <ChartCard
      className="home-chart--activity"
      title="Activité de contact par semaine"
      tip="Par semaine (lundi au dimanche, Paris) : personnes contactées pour la première fois, personnes relancées, rendez-vous obtenus, et personnes qui ne souhaitent plus être contactées (non intéressées ou ignorées). Chaque personne compte une fois par type d’événement ; les reprises d’historique par import ne sont pas des événements."
    >
      <Legend items={series.map((entry) => ({ key: entry.key, label: entry.label, color: entry.color, total: sum(entry.values) }))} />
      <StackedBars caption="Activité de contact par semaine" columns={columnsOf(weeks)} series={series} />
      {empty && <p className="home-chart__empty">Aucun événement de contact enregistré sur ces semaines.</p>}
    </ChartCard>
  )
}

function Gauge({ label, value, part, whole, color }: { label: string; value: number | undefined; part: number; whole: number; color: string }) {
  const radius = 44
  const circumference = 2 * Math.PI * radius
  const filled = value === undefined ? 0 : Math.min(1, value) * circumference
  return (
    <div className="gauge" role="group" aria-label={`${label} : ${percent(value)} (${NUMBER.format(part)} sur ${NUMBER.format(whole)})`}>
      <svg className="gauge__ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="gauge__track" cx="60" cy="60" r={radius} />
        <circle className="gauge__value" cx="60" cy="60" r={radius} stroke={color} strokeDasharray={`${String(filled)} ${String(circumference)}`} transform="rotate(-90 60 60)">
          <title>{`${label} : ${NUMBER.format(part)} sur ${NUMBER.format(whole)} (${percent(value)})`}</title>
        </circle>
      </svg>
      <span className="gauge__figure">{percent(value)}</span>
      <span className="gauge__label">{label}</span>
      <span className="gauge__detail">{NUMBER.format(part)} / {NUMBER.format(whole)}</span>
    </div>
  )
}

function ConversionChart({ totals }: { totals: ConversionTotals }) {
  return (
    <ChartCard
      className="home-chart--conversion"
      title="Conversion des prospects contactés"
      tip="À gauche : part des personnes contactées qui ont pris rendez-vous. À droite : toutes les personnes de la base, classées une seule fois — rendez-vous pris, ignorées (ont décliné, ou sont allées jusqu’à la dernière relance sans répondre), contactées, non contactées. Photo de la base aujourd’hui, pas une somme des semaines."
    >
      <div className="gauges">
        <Gauge label="Rendez-vous / contacts" value={ratio(totals.with_appointment, totals.contacted)} part={totals.with_appointment} whole={totals.contacted} color="var(--color-warning-fg)" />
        <PieChart
          caption="Répartition de la base"
          slices={[
            { key: 'appointment', label: 'Rendez-vous pris', value: totals.base_appointment, color: 'var(--color-warning-fg)' },
            { key: 'contacted', label: 'Contactés', value: totals.base_contacted, color: 'var(--color-info-fg)' },
            { key: 'not_contacted', label: 'Non contactés', value: totals.base_not_contacted, color: 'var(--color-neutral-fg)' },
            { key: 'ignored', label: 'Ignorés', value: totals.base_ignored, color: 'var(--color-danger-fg)' },
          ]}
        />
      </div>
    </ChartCard>
  )
}

const GROWTH = [
  { key: 'prospects', label: 'Prospects', color: 'var(--color-info-fg)' },
  { key: 'companies', label: 'Entreprises', color: 'var(--color-violet-fg)' },
  { key: 'warehouses', label: 'Entrepôts', color: 'var(--color-accent-2-fg)' },
] as const

function GrowthChart({ weeks }: { weeks: WeekPoint[] }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setHidden(next)
  }
  // The real size of the base at the end of each week; the scale follows the curves still shown.
  const series: BarSeries[] = GROWTH.map((entry) => ({ ...entry, values: weeks.map((week) => week.base[entry.key]) }))
  const columns = weeks.map((week) => ({ label: weekStartLabel(week), title: weekRange(week) }))
  return (
    <ChartCard
      className="home-chart--growth"
      title="Croissance de la base par semaine"
      tip="Nombre total de fiches existantes à la fin de chaque semaine (lundi indiqué) : prospects, entreprises, entrepôts (sites, sans leurs contacts). Cliquez sur la légende pour masquer ou afficher une courbe ; l’échelle s’ajuste."
    >
      <Legend
        items={series.map((entry) => ({ key: entry.key, label: entry.label, color: entry.color, total: entry.values.at(-1) ?? 0 }))}
        hidden={hidden}
        onToggle={toggle}
      />
      <LineChart caption="Taille de la base en fin de semaine" columns={columns} series={series.filter((entry) => !hidden.has(entry.key))} />
    </ChartCard>
  )
}

export function HomeCharts({ series }: { series: WeeklySeries }) {
  return (
    <div className="home-charts">
      <ActivityChart weeks={series.weeks} />
      <ConversionChart totals={series.totals} />
      <GrowthChart weeks={series.weeks} />
    </div>
  )
}
