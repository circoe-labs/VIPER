import { COMPANY_PAGE_SIZE, type ListSort, useCompanies, useCompanyCounts } from '../api/companies'
import { CompanyTable } from '../companies/CompanyTable'
import { useCompanyEditor } from '../companies/CompanyEditorProvider'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { AlertIcon, BuildingIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SpinnerIcon } from '../ui/icons'
import { sortFor } from './criteria'
import type { EntityPanelProps } from './entityPanel'
import { activeFilters } from './filterChips'
import { EntityToolbar } from './EntityToolbar'
import { ProspectionControls } from './ProspectionFilters'

const NUMBER = new Intl.NumberFormat('fr-FR')
// Entreprises: control bar (search, sort, filters), then the existing company table and editor. State lives in the
// URL: `entity=company`, `q`, `sort`, `page` and the entity's filters (criteria.ts).
export function CompaniesPanel({ view, update, refine, search }: EntityPanelProps) {
  const openEditor = useCompanyEditor()
  const counts = useCompanyCounts()
  const query = view.q.trim()
  const sort = sortFor(view) as ListSort
  const offset = (view.page - 1) * COMPANY_PAGE_SIZE
  const companies = useCompanies(query, offset, COMPANY_PAGE_SIZE, {
    company_kind: view.company_kind,
    commercial_segment: view.commercial_segment,
    activity_category: view.activity_category,
    department: view.department,
    services: view.services,
    status: view.file_status,
    created_from: view.created_from,
    created_to: view.created_to,
  }, sort)
  const page = companies.data
  const last = page ? Math.min(offset + page.items.length, page.total) : 0
  const filtered = activeFilters(view).length > 0 || query !== ''

  return (
    <section aria-label="Entreprises">
      <ProspectionControls view={view} onChange={refine} search={search} />
      <EntityToolbar
        title="Toutes les entreprises"
        count={page ? `${NUMBER.format(page.total)} ${page.total > 1 ? 'entreprises' : 'entreprise'}` : undefined}
        description="Les sociétés de la base, avec leur type et leurs établissements."
        busy={companies.isFetching}
        actions={<Button variant="primary" icon={PlusIcon} onClick={() => { openEditor('new') }}>Nouvelle entreprise</Button>}
      />
      {counts.isError && <p role="alert" className="prospection__state prospection__state--error"><AlertIcon size={18} />Répartition indisponible.<Button size="sm" onClick={() => void counts.refetch()}>Réessayer</Button></p>}
      {companies.isPending && <p role="status" className="prospection__state"><SpinnerIcon size={18} className="btn__spinner" />Chargement des entreprises…</p>}
      {companies.isError && <p role="alert" className="prospection__state prospection__state--error"><AlertIcon size={18} />Liste des entreprises indisponible.<Button size="sm" onClick={() => void companies.refetch()}>Réessayer</Button></p>}
      {page?.total === 0 && (filtered
        ? <p className="prospection__state">Aucune entreprise ne correspond à ces critères.</p>
        : <EmptyState icon={BuildingIcon} title="Aucune entreprise pour l’instant" description="Créez la première fiche : nom, identifiants, classification et établissements." action={<Button icon={PlusIcon} onClick={() => { openEditor('new') }}>Nouvelle entreprise</Button>} />)}
      {page && page.items.length > 0 && <CompanyTable items={page.items} />}
      {page && page.total > COMPANY_PAGE_SIZE && (
        <nav className="prospection__pager" aria-label="Pages des entreprises">
          <span>{NUMBER.format(offset + 1)}–{NUMBER.format(last)} sur {NUMBER.format(page.total)}</span>
          <Button size="sm" icon={ChevronLeftIcon} disabled={view.page <= 1} onClick={() => { update({ page: view.page - 1 }) }}>Précédentes</Button>
          <Button size="sm" icon={ChevronRightIcon} disabled={last >= page.total} onClick={() => { update({ page: view.page + 1 }) }}>Suivantes</Button>
        </nav>
      )}
    </section>
  )
}
