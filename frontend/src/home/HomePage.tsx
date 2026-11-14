import { Link } from 'react-router'

import { useWeeklyMetrics, useWeeklySeries } from '../api/metrics'
import { useMissions } from '../api/missions'
import { filtersOf, useProspectionCounters } from '../api/prospection'
import { useCurrentUser } from '../auth/currentUser'
import { DEFAULT_VIEW } from '../prospection/criteria'
import { Button } from '../ui/Button'
import { AlertIcon, SpinnerIcon, UploadIcon, UsersIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { buildCockpit, type CockpitCard } from './cockpit'
import { HOME_SHORTCUTS } from './destinations'
import { HomeCharts } from './HomeCharts'
import './home-dashboard.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
// Home asks Prospection for its panel sizes unfiltered: the cockpit counts the whole base.
const FILTERS = filtersOf(DEFAULT_VIEW)
const TODAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

// A KPI card: icon tile, label, figure; the whole card is the link to its filtered destination. A weekly addition
// (`growth`) carries a « cette semaine » chip so it is never read as a total.
function DashboardCard({ label, count, icon: Icon, tone, href, growth = false, hint }: CockpitCard) {
  const formatted = NUMBER.format(count)
  const accessible = `${growth ? '+ ' : ''}${formatted} ${label}${growth ? ' cette semaine' : ''}${hint ? ` ${hint}` : ''}`
  return (
    <li>
      <Link className={`home-stat home-stat--${tone}`} to={href} aria-label={accessible}>
        <span className="home-stat__icon"><Icon size={22} /></span>
        <span className="home-stat__label">{label}</span>
        <span className="home-stat__figure">
          <span className="home-stat__value">{growth ? '+ ' : ''}{formatted}</span>
          {growth && <span className="home-stat__chip">cette semaine</span>}
          {hint && <span className="home-stat__chip home-stat__chip--warn">{hint}</span>}
        </span>
      </Link>
    </li>
  )
}

function greeting(name: string): string {
  const hour = new Date().getHours()
  const first = name.trim().split(/\s+/)[0] ?? ''
  const hello = hour >= 18 || hour < 5 ? 'Bonsoir' : 'Bonjour'
  return first ? `${hello} ${first}` : hello
}

export function HomePage() {
  const metrics = useWeeklyMetrics()
  const counters = useProspectionCounters(FILTERS)
  const missions = useMissions()
  const user = useCurrentUser()
  const sections = buildCockpit({ metrics: metrics.data, counters: counters.data, missions: missions.data })
  const loading = metrics.isPending || counters.isPending || missions.isPending
  const failed = metrics.isError || counters.isError || missions.isError
  const refetch = () => { for (const query of [metrics, counters, missions]) if (query.isError) void query.refetch() }
  const series = useWeeklySeries()
  const cards = sections.flatMap((section) => section.cards)
  return (
    <div className="home-dashboard">
      <PageHeader
        mascot="hello"
        title="Accueil"
        description={`${greeting(user.display_name)} 👋 Où en sont la base et l’activité de contact — ${TODAY.format(new Date())}.`}
        actions={
          <>
            <Link className="btn btn--secondary btn--md" to={HOME_SHORTCUTS.importExcel}><UploadIcon size={18} /> Importer Excel</Link>
            <Link className="btn btn--primary btn--md" to={HOME_SHORTCUTS.prospection}><UsersIcon size={18} /> Ouvrir la prospection</Link>
          </>
        }
      />
      {loading && <p className="home-dashboard__state" role="status"><SpinnerIcon size={18} className="btn__spinner" /> Chargement des statistiques…</p>}
      {failed && <div className="home-dashboard__state home-dashboard__state--error" role="alert"><AlertIcon size={18} /> Impossible de charger certaines statistiques de VIPER. <Button size="sm" onClick={refetch}>Réessayer</Button></div>}
      {cards.length > 0 && <ul className="home-dashboard__cards" aria-label="Indicateurs">{cards.map((card) => <DashboardCard key={card.id} {...card} />)}</ul>}
      {series.data && <HomeCharts series={series.data} />}
      {series.isPending && <p className="home-dashboard__state" role="status"><SpinnerIcon size={18} className="btn__spinner" /> Chargement des graphiques…</p>}
      {series.isError && <div className="home-dashboard__state home-dashboard__state--error" role="alert"><AlertIcon size={18} /> Impossible de charger les graphiques. <Button size="sm" onClick={() => void series.refetch()}>Réessayer</Button></div>}
    </div>
  )
}
