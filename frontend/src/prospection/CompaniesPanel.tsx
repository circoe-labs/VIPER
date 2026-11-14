import { COMPANY_PAGE_SIZE, type CompanyKindSelection, useCompanies, useCompanyCounts } from '../api/companies'
import { CompanyTable } from '../companies/CompanyTable'
import { useCompanyEditor } from '../companies/CompanyEditorProvider'
import { Button } from '../ui/Button'
import { CreationPeriod } from '../ui/CreationPeriod'
import { EmptyState } from '../ui/EmptyState'
import { AlertIcon, BuildingIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SpinnerIcon } from '../ui/icons'
import { type Capsule, EntityCapsules } from './EntityCapsules'
import { type EntityPanelProps, weeklyFor } from './entityPanel'
import { useWeeklyAdditions } from './weeklyAdditions'

const NUMBER = new Intl.NumberFormat('fr-FR')
const KINDS: readonly { value: CompanyKindSelection; label: string; hint: string }[] = [
  { value: null, label: 'Toutes', hint: 'Chaque entreprise apparaît une seule fois, y compris sans prospect associé' },
  { value: 'institutional', label: 'Institutionnelles', hint: 'Entreprises de type institutionnel' },
  { value: 'sme', label: 'PME', hint: 'Entreprises de type PME' },
  { value: 'large', label: 'Grosses entreprises', hint: 'Entreprises de type grande entreprise' },
  { value: 'unclassified', label: 'À classer', hint: 'Sans type : à renseigner dans la fiche entreprise' },
]

// Entreprises: type capsules (figure + filter), search, then the existing company table and editor. State lives in the
// URL: `entity=company`, `company_kind`, `q`, `page`, `created_from`/`created_to`.
export function CompaniesPanel({ view, update, refine, search }: EntityPanelProps) {
  const openEditor = useCompanyEditor()
  const counts = useCompanyCounts()
  const weekly = useWeeklyAdditions()
  const query = view.q.trim()
  const offset = (view.page - 1) * COMPANY_PAGE_SIZE
  const companies = useCompanies(query, offset, COMPANY_PAGE_SIZE, view.company_kind, view.created_from, view.created_to)
  const page = companies.data
  const last = page ? Math.min(offset + page.items.length, page.total) : 0
  const capsules: Capsule[] = KINDS.map(({ value, label, hint }) => ({
    key: value ?? 'all',
    label,
    hint,
    count: counts.data?.[value ?? 'all'],
    failed: counts.isError,
    pressed: view.company_kind === value,
    onSelect: () => { refine({ company_kind: value }) },
    weekly: value === null ? weeklyFor(weekly, 'company') : undefined,
  }))
  const filtered = view.company_kind !== null || query !== ''

  return (
    <section aria-label="Entreprises">
      <EntityCapsules label="Type d’entreprise" capsules={capsules} />
      <CreationPeriod start={view.created_from} end={view.created_to} onClear={() => { refine({ created_from: null, created_to: null }) }} />
      <div className="entity-panel__toolbar">
        {search}
        {page && <span className="entity-panel__count" aria-live="polite">{NUMBER.format(page.total)} {page.total > 1 ? 'entreprises' : 'entreprise'}</span>}
        {companies.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
        <Button variant="primary" icon={PlusIcon} onClick={() => { openEditor('new') }}>Nouvelle entreprise</Button>
      </div>
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
