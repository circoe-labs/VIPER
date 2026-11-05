import { Link } from 'react-router'
import { useCompanyCounts } from '../api/companies'
import { filtersOf, useProspectionCounters, useProspectionOverview } from '../api/prospection'
import { DEFAULT_VIEW } from './criteria'
import { BuildingIcon, CalendarIcon, ChevronRightIcon, MailIcon, UsersIcon } from '../ui/icons'
import './overview.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

// These figures describe the whole base. Search and work filters live in the next section.
export function OverviewPanel({ onOpenList }: { onOpenList?: () => void }) {
  const overview = useProspectionOverview()
  const companies = useCompanyCounts()
  const counters = useProspectionCounters(filtersOf(DEFAULT_VIEW))
  const cards = [
    { label: 'Prospects', value: overview.data?.total, error: overview.isError, icon: UsersIcon, href: '/prospection?list=1', hint: 'Personnes présentes dans la base', tone: 'blue' },
    { label: 'Entreprises', value: companies.data?.all, error: companies.isError, icon: BuildingIcon, href: '/prospection/companies', hint: 'Fiches entreprises distinctes', tone: 'purple' },
    { label: 'Avec un échange', value: overview.data?.contacted, error: overview.isError, icon: MailIcon, href: '/prospection?segment=contacted', hint: 'Envoi, réponse ou RDV enregistré', tone: 'green' },
    { label: 'RDV pris', value: counters.data?.counts.appointments, error: counters.isError, icon: CalendarIcon, href: '/prospection?segment=appointments', hint: 'Prospects avec un rendez-vous enregistré', tone: 'orange' },
  ]
  return <section className="overview" aria-labelledby="overview-title">
    <div className="prospection-section__head">
      <h2 id="overview-title">Vue d’ensemble</h2>
      <span>Toute la base · hors filtres</span>
    </div>
    <div className="overview__figures">
      {cards.map(({ label, value, error, icon: Icon, href, hint, tone }) => <Link key={label} to={href} onClick={onOpenList} className={`overview__figure overview__figure--${tone}`}>
        <span className="overview__label"><Icon size={19} />{label}<ChevronRightIcon size={16} /></span>
        <strong>{error ? 'Indisponible' : value === undefined ? '…' : NUMBER.format(value)}</strong>
        <span className="overview__hint">{hint}</span>
      </Link>)}
    </div>
    <p className="overview__archive">{overview.isError ? 'Historique des suppressions indisponible.' : overview.data ? `${NUMBER.format(overview.data.deleted)} prospects supprimés depuis l’origine, déjà exclus des chiffres ci-dessus.` : 'Chargement du bilan…'}</p>
  </section>
}
