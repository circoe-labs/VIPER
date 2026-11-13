import { Link } from 'react-router'

import { type HomeDashboard, useHomeDashboard } from '../api/home'
import { useCurrentUser } from '../auth/currentUser'
import { mascotSource } from '../brand/mascots'
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
      { label: 'Contactés', count: data?.contacted, icon: MailIcon, tone: 'green', href: undefined },
      { label: 'RDV pris', count: data?.appointments, icon: CalendarIcon, tone: 'orange', href: '/prospection?segment=appointments' },
    ],
  }
}

function greeting(name: string): string {
  const hour = new Date().getHours()
  const first = name.trim().split(/\s+/)[0] ?? ''
  const hello = hour >= 18 || hour < 5 ? 'Bonsoir' : 'Bonjour'
  return first ? `${hello} ${first}` : hello
}

export function HomePage() {
  const home = useHomeDashboard()
  const user = useCurrentUser()
  const groups = cards(home.data)
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
          <Link className="btn btn--secondary btn--md" to="/prospection/import"><UploadIcon size={19} /> Importer Excel</Link>
          <Link className="btn btn--primary btn--md" to="/prospection"><UsersIcon size={19} /> Ouvrir la prospection</Link>
        </div>
      </header>
      {home.isPending && <p className="home-dashboard__state" role="status"><SpinnerIcon size={18} className="btn__spinner" /> Chargement des statistiques…</p>}
      {home.isError && <div className="home-dashboard__state home-dashboard__state--error" role="alert"><AlertIcon size={18} /> Impossible de charger les statistiques de VIPER. <Button size="sm" onClick={() => void home.refetch()}>Réessayer</Button></div>}
      <ul className="home-dashboard__totals" aria-label="Chiffres clés">
        {groups.primary.map((card) => <DashboardCard key={card.label} {...card} />)}
      </ul>
      {home.data && <p className="home-dashboard__prospect-note">Prospects : <Link to="/prospection?list=1">{NUMBER.format(home.data.prospects - home.data.warehouse_contacts)} en prospection</Link> et <Link to="/warehouses">{NUMBER.format(home.data.warehouse_contacts)} contacts d’entrepôt</Link>.</p>}
      <Link className="home-opportunities-link" to="/prospection/opportunities"><span><strong>Opportunités à explorer</strong><small>6 pistes de prospection en Normandie</small></span><ChevronRightIcon size={21} /></Link>
      <Link className="home-opportunities-link" to="/missions"><span><strong>Veille</strong><small>Missions de veille et signaux d’achat à valider</small></span><ChevronRightIcon size={21} /></Link>
    </div>
  )
}
