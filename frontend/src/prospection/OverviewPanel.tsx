import { Link } from 'react-router'
import { useCompanyCounts } from '../api/companies'
import { useHomeDashboard } from '../api/home'
import { useWarehouseCounts, useWarehouses } from '../api/warehouses'
import { filtersOf, useProspectionCounters, useProspectionOverview } from '../api/prospection'
import { DEFAULT_VIEW } from './criteria'
import { BuildingIcon, CalendarIcon, ChevronRightIcon, MailIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import './overview.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

// These figures describe the whole base. Search and work filters live in the next section.
export function OverviewPanel({ onOpenList }: { onOpenList?: () => void }) {
  const overview = useProspectionOverview()
  const weekly = useHomeDashboard()
  const companies = useCompanyCounts()
  const warehouses = useWarehouses('', 0)
  const warehouseCounts = useWarehouseCounts()
  const totalProspects = overview.data && warehouseCounts.data ? overview.data.total + warehouseCounts.data.contacts : undefined
  const counters = useProspectionCounters(filtersOf(DEFAULT_VIEW))
  const cards = [
    { label: 'Prospects', value: totalProspects, error: overview.isError || warehouseCounts.isError, icon: UsersIcon, href: '/prospection?list=1', hint: warehouseCounts.data ? `Fiches prospection et ${NUMBER.format(warehouseCounts.data.contacts)} interlocuteurs entrepôt (visibles dans Contacts)` : 'Fiches prospection et interlocuteurs entrepôt', tone: 'blue', activity: weekly.data?.weekly_activity?.prospects, activityLabel: 'fiches prospection ajoutées' },
    { label: 'Entreprises', value: companies.data?.all, error: companies.isError, icon: BuildingIcon, href: '/prospection/companies', hint: 'Fiches entreprises distinctes', tone: 'purple', activity: weekly.data?.weekly_activity?.companies, activityLabel: 'ajoutées' },
    { label: 'Entrepôts', value: warehouses.data?.total, error: warehouses.isError, icon: WarehouseIcon, href: '/warehouses', hint: 'Sites dans le répertoire', tone: 'teal', activity: weekly.data?.weekly_activity?.warehouses, activityLabel: 'ajoutés' },
    { label: 'Avec un échange', value: overview.data?.contacted, error: overview.isError, icon: MailIcon, href: '/prospection?segment=contacted', hint: 'Envoi, réponse ou RDV enregistré', tone: 'green', activity: weekly.data?.weekly_activity?.contacts, activityLabel: 'premiers contacts enregistrés' },
    { label: 'RDV pris', value: counters.data?.counts.appointments, error: counters.isError, icon: CalendarIcon, href: '/prospection?segment=appointments', hint: 'Prospects avec un rendez-vous enregistré', tone: 'orange', activity: weekly.data?.weekly_activity?.appointments, activityLabel: 'RDV obtenus enregistrés' },
  ]
  return <section className="overview" aria-labelledby="overview-title">
    <div className="prospection-section__head">
      <h2 id="overview-title">Vue d’ensemble</h2>
      <span>Toute la base · hors filtres</span>
    </div>
    <div className="overview__figures">
      {cards.map(({ label, value, error, icon: Icon, href, hint, tone, activity, activityLabel }) => <Link key={label} to={href} onClick={onOpenList} className={`overview__figure overview__figure--${tone}`}>
        <span className="overview__label"><Icon size={19} />{label}<ChevronRightIcon size={16} /></span>
        <strong>{error ? 'Indisponible' : value === undefined ? '…' : NUMBER.format(value)}</strong>
        <span className="overview__hint">{hint}</span>
        <span className="overview__activity">{activity === undefined ? 'Activité hebdomadaire indisponible' : <><span aria-hidden="true">{activity > 0 ? '↗' : '→'}</span> {NUMBER.format(activity)} {activityLabel} cette semaine</>}</span>
      </Link>)}
    </div>
    <p className="overview__archive">{overview.isError ? 'Historique des suppressions indisponible.' : overview.data ? `${NUMBER.format(overview.data.deleted)} prospects supprimés depuis l’origine, déjà exclus des chiffres ci-dessus.` : 'Chargement du bilan…'}</p>
  </section>
}
