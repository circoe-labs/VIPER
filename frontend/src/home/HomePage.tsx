import { Link } from 'react-router'

import { useWeeklyMetrics } from '../api/metrics'
import { useMissions } from '../api/missions'
import { filtersOf, useProspectionCounters } from '../api/prospection'
import { useCurrentUser } from '../auth/currentUser'
import { mascotSource } from '../brand/mascots'
import { DEFAULT_VIEW } from '../prospection/criteria'
import { Button } from '../ui/Button'
import { AlertIcon, ChevronRightIcon, SpinnerIcon, UploadIcon, UsersIcon } from '../ui/icons'
import { buildCockpit, type CockpitCard } from './cockpit'
import { HOME_SHORTCUTS } from './destinations'
import './home-dashboard.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
// Home asks Prospection for its panel sizes unfiltered: the cockpit counts the whole base.
const FILTERS = filtersOf(DEFAULT_VIEW)
const TODAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

function DashboardCard({ label, count, icon: Icon, tone, href, growth = false, hint }: CockpitCard) {
  const formatted = NUMBER.format(count)
  const accessible = `${growth ? '+ ' : ''}${formatted} ${label}${growth ? ' cette semaine' : ''}${hint ? ` ${hint}` : ''}`
  const className = `home-stat home-stat--${tone}${growth ? ' home-stat--growth' : ''}`
  return (
    <li>
      <Link className={className} to={href} aria-label={accessible}>
        <span className="home-stat__icon"><Icon size={growth ? 30 : 25} /></span>
        <div className="home-stat__content">
          {!growth && <span className="home-stat__label">{label}</span>}
          <span className="home-stat__value">{growth ? '+ ' : ''}{formatted}</span>
          {growth && <div className="home-stat__description"><span>{label}</span><small>cette semaine</small></div>}
          {hint && <small className="home-stat__hint">{hint}</small>}
        </div>
        <ChevronRightIcon className="home-stat__chevron" size={21} />
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
  return (
    <div className="home-dashboard">
      <header className="home-dashboard__header">
        <div className="home-dashboard__intro">
          <img className="home-dashboard__mascot" src={mascotSource('hello')} alt="" />
          <div>
            <h1>Accueil</h1>
            <p>{greeting(user.display_name)} 👋 Où en sont la base et l’activité de contact — {TODAY.format(new Date())}.</p>
          </div>
        </div>
        <div className="home-dashboard__actions">
          <Link className="btn btn--secondary btn--md" to={HOME_SHORTCUTS.importExcel}><UploadIcon size={19} /> Importer Excel</Link>
          <Link className="btn btn--primary btn--md" to={HOME_SHORTCUTS.prospection}><UsersIcon size={19} /> Ouvrir la prospection</Link>
        </div>
      </header>
      {loading && <p className="home-dashboard__state" role="status"><SpinnerIcon size={18} className="btn__spinner" /> Chargement des statistiques…</p>}
      {failed && <div className="home-dashboard__state home-dashboard__state--error" role="alert"><AlertIcon size={18} /> Impossible de charger certaines statistiques de VIPER. <Button size="sm" onClick={refetch}>Réessayer</Button></div>}
      {sections.map((section) => (
        <section className="home-dashboard__section" key={section.title} aria-labelledby={`home-${section.title}`}>
          <h2 id={`home-${section.title}`}>{section.title}</h2>
          <ul className={`home-dashboard__totals${section.cards[0]?.growth ? ' home-dashboard__growth' : ''}`}>
            {section.cards.map((card) => <DashboardCard key={card.id} {...card} />)}
          </ul>
        </section>
      ))}
    </div>
  )
}
