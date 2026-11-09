import { Link } from 'react-router'

import { type HomeDashboard, useHomeDashboard } from '../api/home'
import { Button } from '../ui/Button'
import { AlertIcon, BuildingIcon, CalendarIcon, ChevronRightIcon, type IconComponent, MailIcon, SpinnerIcon, UploadIcon, UsersIcon } from '../ui/icons'
import './home-dashboard.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const TODAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

interface CardProps {
  label: string
  count: number | undefined
  icon: IconComponent
  tone: 'blue' | 'purple' | 'green' | 'orange' | 'emerald'
  href: string | undefined
  growth?: boolean
}

function DashboardCard({ label, count, icon: Icon, tone, href, growth = false }: CardProps) {
  const formatted = count === undefined ? '—' : NUMBER.format(count)
  const accessible = `${growth && count !== undefined ? '+ ' : ''}${formatted} ${label}${growth ? ' cette semaine' : ''}`
  const className = `home-stat home-stat--${tone}${growth ? ' home-stat--growth' : ''}`
  const content = <>
    <span className="home-stat__icon"><Icon size={growth ? 30 : 25} /></span>
    <div className="home-stat__content">
      {!growth && <span className="home-stat__label">{label}</span>}
      <span className="home-stat__value">{growth && count !== undefined ? '+ ' : ''}{formatted}</span>
      {growth && <div className="home-stat__description"><span>{label}</span><small>cette semaine</small></div>}
    </div>
    <ChevronRightIcon className="home-stat__chevron" size={21} />
  </>
  return <li>{href ? <Link className={className} to={href} aria-label={accessible}>{content}</Link> : <div className={className} aria-label={accessible} aria-busy={count === undefined}>{content}</div>}</li>
}

function cards(data: HomeDashboard | undefined): { primary: CardProps[] } {
  return {
    primary: [
      { label: 'Prospects', count: data?.prospects, icon: UsersIcon, tone: 'blue', href: '/prospection?list=1' },
      { label: 'Entreprises', count: data?.companies, icon: BuildingIcon, tone: 'purple', href: '/prospection/companies' },
      { label: 'Contactés', count: data?.contacted, icon: MailIcon, tone: 'green', href: '/contact?section=CONTACTES' },
      { label: 'RDV pris', count: data?.appointments, icon: CalendarIcon, tone: 'orange', href: '/prospection?segment=appointments' },
    ],
  }
}

function ProspectTrend({ data }: { data: HomeDashboard | undefined }) {
  const weeks = data?.prospect_trend ?? []
  const maximum = Math.max(1, ...weeks.flatMap((week) => [week.prospects, week.warehouses]))
  const label = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return <section className="home-trend" aria-labelledby="home-trend-title">
    <div className="home-trend__header">
      <div><h2 id="home-trend-title">Évolution des ajouts</h2><p>Nouveaux prospects · semaine dernière et semaine en cours</p></div>
      <div className="home-trend__legend"><span>Prospection</span><span>Entrepôt</span></div>
    </div>
    {data && weeks.length > 0 ? <>
      <svg className="home-trend__lines" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((step) => <line key={step} x1="60" x2="540" y1={20 + step * 40} y2={20 + step * 40} className="home-trend__gridline" />)}
        {(['prospects', 'warehouses'] as const).map((series) => {
          const points = weeks.map((week, index) => ({ x: weeks.length === 1 ? 300 : 60 + index * 480 / (weeks.length - 1), y: 180 - week[series] / maximum * 150, value: week[series] }))
          return <g key={series} className={`home-trend__series home-trend__series--${series}`}>
            <polyline points={points.map(({ x, y }) => `${x},${y}`).join(' ')} />
            {points.map(({ x, y, value }, index) => <g key={index}><circle cx={x} cy={y} r="5" /><text x={x} y={y - 10} textAnchor="middle">{NUMBER.format(value)}</text></g>)}
          </g>
        })}
      </svg>
      <ul className="home-trend__chart" aria-label="Ajouts hebdomadaires">
        {weeks.map((week, index) => <li key={week.week} aria-label={`Semaine du ${label.format(new Date(`${week.week}T00:00:00Z`))} : ${NUMBER.format(week.prospects)} prospects en prospection, ${NUMBER.format(week.warehouses)} prospects entrepôt`}>
          <span className="home-trend__month">{index === 0 ? 'Semaine dernière' : 'Cette semaine'}<br />{label.format(new Date(`${week.week}T00:00:00Z`))}</span>
        </li>)}
      </ul>
    </> : <p className="home-trend__empty">{data ? 'Aucune donnée disponible.' : 'Données indisponibles.'}</p>}
    <p className="home-trend__note">Les prospects entrepôt sont rattachés à la semaine de création de leur fiche d’entrepôt.</p>
  </section>
}

export function HomePage() {
  const home = useHomeDashboard()
  const groups = cards(home.data)
  return (
    <div className="home-dashboard">
      <header className="home-dashboard__header">
        <div>
          <h1>Accueil</h1>
          <p>Où en sont la base et l’activité de contact — {TODAY.format(new Date())}.</p>
        </div>
        <div className="home-dashboard__actions">
          <Link className="btn btn--secondary btn--md" to="/prospection/import"><UploadIcon size={19} /> Importer Excel</Link>
          <Link className="btn btn--primary btn--md" to="/prospection"><UsersIcon size={19} /> Ouvrir la prospection</Link>
        </div>
      </header>
      {home.isPending && <p className="home-dashboard__state" role="status"><SpinnerIcon size={18} className="btn__spinner" /> Chargement des statistiques…</p>}
      {home.isError && <div className="home-dashboard__state home-dashboard__state--error" role="alert"><AlertIcon size={18} /> Impossible de charger les statistiques de VIPER. <Button size="sm" onClick={() => void home.refetch()}>Réessayer</Button></div>}
      <ul className="home-dashboard__totals" aria-label="Chiffres clés">
        {groups.primary.map((card) => <DashboardCard key={card.label} {...card} />)}
      </ul>
      {home.data && <p className="home-dashboard__prospect-note">Prospects : <Link to="/prospection?list=1">{NUMBER.format(home.data.prospects - home.data.warehouse_contacts)} en prospection</Link> et <Link to="/warehouses">{NUMBER.format(home.data.warehouse_contacts)} contacts d?entrep?t</Link>. Une personne pr?sente dans les deux listes peut ?tre compt?e deux fois.</p>}
      <Link className="home-opportunities-link" to="/prospection/opportunities"><span><strong>Opportunit?s ? explorer</strong><small>6 pistes de prospection en Normandie</small></span><ChevronRightIcon size={21} /></Link>
      <ProspectTrend data={home.data} />
    </div>
  )
}
