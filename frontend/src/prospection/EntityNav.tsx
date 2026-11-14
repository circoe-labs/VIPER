import { Link } from 'react-router'

import { useCompanyCounts } from '../api/companies'
import { useProspectionOverview } from '../api/prospection'
import { useWarehouseCounts } from '../api/warehouses'
import { BuildingIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import { type Entity, entityHref, type ProspectionView } from './criteria'
import { weeklyFor } from './entityPanel'
import { useWeeklyAdditions } from './weeklyAdditions'
import './entities.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ENTITY_ITEMS = [
  { entity: 'prospect', label: 'Prospects', icon: UsersIcon },
  { entity: 'company', label: 'Entreprises', icon: BuildingIcon },
  { entity: 'warehouse', label: 'Entrepôts', icon: WarehouseIcon },
] as const

// The entity selector, drawn as three KPI cards (icon, name, total, « +N cette semaine »). Links, not tabs: each
// entity is a URL (`?entity=`), so Back/Forward and bookmarks keep working. Switching drops the filters that do not
// mean anything for the new entity (criteria.ts `switchEntity`). The weekly figure is never invented: nothing while
// loading, « — » when the source has no figure.
export function EntityNav({ view }: { view: ProspectionView }) {
  const prospects = useProspectionOverview()
  const companies = useCompanyCounts()
  const warehouses = useWarehouseCounts()
  const weekly = useWeeklyAdditions()
  const totals: Record<Entity, number | undefined> = {
    prospect: prospects.data?.total,
    company: companies.data?.all,
    warehouse: warehouses.data?.warehouses,
  }
  return (
    <nav className="entity-cards" aria-label="Type de fiche">
      {ENTITY_ITEMS.map(({ entity: item, label, icon: Icon }) => {
        const total = totals[item]
        const added = weeklyFor(weekly, item)
        return (
          <Link key={item} to={entityHref(view, item)} className="entity-card" aria-current={item === view.entity ? 'page' : undefined}>
            <span className="entity-card__icon"><Icon size={20} /></span>
            <span className="entity-card__name">{label}</span>
            <strong className="entity-card__total">{total === undefined ? '…' : NUMBER.format(total)}</strong>
            {added !== undefined && (
              <span className={added === null ? 'entity-card__delta entity-card__delta--unknown' : 'entity-card__delta'} title={added === null ? 'Ajouts de la semaine indisponibles' : undefined}>
                {added === null ? '—' : `+${NUMBER.format(added)} cette semaine`}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
