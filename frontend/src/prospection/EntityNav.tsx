import { Link } from 'react-router'

import { useCompanyCounts } from '../api/companies'
import { useProspectionOverview } from '../api/prospection'
import { useWarehouseCounts } from '../api/warehouses'
import { BuildingIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import { type Entity, entityHref } from './criteria'
import './entities.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ENTITY_ITEMS = [
  { entity: 'prospect', label: 'Prospects', icon: UsersIcon },
  { entity: 'company', label: 'Entreprises', icon: BuildingIcon },
  { entity: 'warehouse', label: 'Entrepôts', icon: WarehouseIcon },
] as const

// The entity selector: top of Prospection, it decides which table the page shows. Links (not tabs): each entity is a
// URL (`?entity=`), so Back/Forward and bookmarks keep working.
export function EntityNav({ entity }: { entity: Entity }) {
  const prospects = useProspectionOverview()
  const companies = useCompanyCounts()
  const warehouses = useWarehouseCounts()
  const totals: Record<Entity, number | undefined> = {
    prospect: prospects.data?.total,
    company: companies.data?.all,
    warehouse: warehouses.data?.warehouses,
  }
  return (
    <nav className="entity-nav" aria-label="Type de fiche">
      {ENTITY_ITEMS.map(({ entity: item, label, icon: Icon }) => {
        const total = totals[item]
        return (
          <Link key={item} to={entityHref(item)} className="entity-nav__link" aria-current={item === entity ? 'page' : undefined}>
            <Icon size={18} />
            <span>{label}</span>
            <span className="entity-nav__count">{total === undefined ? '…' : NUMBER.format(total)}</span>
          </Link>
        )
      })}
    </nav>
  )
}
