import type { ReactNode } from 'react'

import type { ConversionTotals, WeeklySeries, WeekPoint } from '../api/metrics'
import { Card } from '../ui/Card'
import { InfoTip } from '../ui/InfoTip'
import { StackedBars, type BarColumn, type BarSeries } from './StackedBars'
import { percent, ratio, shortWeek, weekRange } from './weekBars'
import './home-charts.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

const columnsOf = (weeks: WeekPoint[]): BarColumn[] => weeks.map((week) => ({ label: shortWeek(week.week), title: weekRange(week) }))
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

function Legend({ items }: { items: { key: string; label: string; color: string; total: number }[] }) {
  return (
    <ul className="chart-legend">
      {items.map((item) => (
        <li key={item.key}>
          <span className="chart-legend__swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
          <strong>{NUMBER.format(item.total)}</strong>
        </li>
      ))}
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
    { key: 'contacts', label: 'Contacts envoyés', color: 'var(--color-info-fg)', values: weeks.map((week) => week.first_contacts) },
    { key: 'responses', label: 'Réponses', color: 'var(--color-accent-fg)', values: weeks.map((week) => week.responses) },
    { key: 'appointments', label: 'Rendez-vous pris', color: 'var(--color-warning-fg)', values: weeks.map((week) => week.appointments) },
  ]
  const empty = series.every((entry) => sum(entry.values) === 0)
  return (
    <ChartCard
      className="home-chart--activity"
      title="Activité de contact par semaine"
      tip="Par semaine (lundi au dimanche, Paris) : prospects contactés pour la première fois, réponses reçues, et premiers rendez-vous pris. Chaque prospect compte une fois par type d’événement ; les reprises d’historique par import ne sont pas des événements."
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
        <circle className="gauge__value" cx="60" cy="60" r={radius} stroke={color} strokeDasharray={`${String(filled)} ${String(circumference)}`} transform="rotate(-90 60 60)" />
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
      tip="Parmi les prospects réellement contactés (au moins un envoi), la part qui a pris rendez-vous (RDV pris ou date de rendez-vous enregistrée) et la part qui a répondu (date de réponse enregistrée). Photo de la base aujourd’hui, pas une somme des semaines."
    >
      <div className="gauges">
        <Gauge label="Rendez-vous pris" value={ratio(totals.with_appointment, totals.contacted)} part={totals.with_appointment} whole={totals.contacted} color="var(--color-warning-fg)" />
        <Gauge label="Réponses" value={ratio(totals.responded, totals.contacted)} part={totals.responded} whole={totals.contacted} color="var(--color-accent-fg)" />
      </div>
      <p className="home-chart__foot">{NUMBER.format(totals.contacted)} prospects contactés</p>
    </ChartCard>
  )
}

const GROWTH = [
  { key: 'prospects', label: 'Prospects', color: 'var(--color-info-fg)' },
  { key: 'companies', label: 'Entreprises', color: 'var(--color-violet-fg)' },
  { key: 'warehouses', label: 'Entrepôts', color: 'var(--color-accent-2-fg)' },
] as const

function GrowthChart({ weeks }: { weeks: WeekPoint[] }) {
  const columns = columnsOf(weeks)
  return (
    <ChartCard
      className="home-chart--growth"
      title="Croissance de la base par semaine"
      tip="Nombre de fiches créées chaque semaine (date de création, jamais de modification) : prospects, entreprises, entrepôts (sites, sans leurs contacts). Chaque graphique a sa propre échelle."
    >
      <div className="growth">
        {GROWTH.map((entry) => {
          const values = weeks.map((week) => week.additions[entry.key])
          return (
            <section className="growth__item" key={entry.key} aria-label={entry.label}>
              <header>
                <h3>{entry.label}</h3>
                <strong>{NUMBER.format(sum(values))}</strong>
                <small>sur {NUMBER.format(weeks.length)} semaines</small>
              </header>
              <StackedBars compact caption={`${entry.label} créés par semaine`} columns={columns} series={[{ key: entry.key, label: entry.label, color: entry.color, values }]} />
            </section>
          )
        })}
      </div>
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
