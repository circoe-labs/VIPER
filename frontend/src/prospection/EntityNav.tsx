import { useCompanyCounts } from '../api/companies'
import { useProspectionOverview } from '../api/prospection'
import { useWarehouseCounts } from '../api/warehouses'
import { BuildingIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import { KpiCard, KpiGrid } from '../ui/KpiCard'
import { type Entity, entityHref, type ProspectionView } from './criteria'
import { weeklyFor } from './entityPanel'
import { useWeeklyAdditions } from './weeklyAdditions'
import './entities.css'

const HINTS: Record<Entity, string> = {
  prospect: 'Les personnes de la base. Cliquer affiche leur liste.',
  company: 'Les entreprises de la base. Cliquer affiche leur liste.',
  warehouse: 'Les entrepôts de la base, avec leur société rattachée. Cliquer affiche leur liste.',
}
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
    <nav aria-label="Type de fiche">
      <KpiGrid label="Compteurs de la base" columns={3}>
        {ENTITY_ITEMS.map(({ entity: item, label, icon }) => (
          <KpiCard
            key={item}
            label={label}
            icon={icon}
            value={totals[item]}
            weekly={weeklyFor(weekly, item)}
            hint={HINTS[item]}
            active={item === view.entity}
            to={entityHref(view, item)}
          />
        ))}
      </KpiGrid>
    </nav>
  )
}
