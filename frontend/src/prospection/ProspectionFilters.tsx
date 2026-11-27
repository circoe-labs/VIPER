import type { ReactNode } from 'react'

import { useImportHistory } from '../api/imports'
import { FILE_STATUS_HINTS, FILE_STATUS_LABELS, FILE_STATUSES } from '../api/fileStatus'
import { COMPANY_KIND_FILTERS, EMAIL_STATES, NONE, REVIEWS, SEND_STAGES, TRACKING_STATUSES, useFilterOptions, VERIFICATION_BOXES } from '../api/prospection'
import { type Cohort, referentName, useCohorts, useReferents, useTaxonomyValues } from '../api/settings'
import { calendarDate } from '../lib/calendarDate'
import { businessToday } from '../lib/isoWeek'
import { Button } from '../ui/Button'
import { Combobox, type ComboboxOption } from '../ui/Combobox'
import { ActiveChips, ApplyFilterMenu, ControlBar, SortSelect } from '../ui/ControlBar'
import { Switch, TextField } from '../ui/fields'
import { MultiSelect, type MultiSelectOption } from '../ui/MultiSelect'
import { ACTIVITIES, clearedFilters, ENTITY_SORTS, type ProspectionView, sortFor, type ViewSort, WAREHOUSE_CATEGORIES } from './criteria'
import { activeFilters, BOX_LABELS, COMPANY_KIND_CHOICES, EMAIL_STATE_LABELS, type FilterNames, NONE_LABELS, SEND_STAGE_LABELS, WAREHOUSE_CATEGORY_LABELS } from './filterChips'
import { ACTIVITY_LABELS, formatDay, REVIEW_INFO, SORT_LABELS, TRACKING_LABELS } from './labels'
import { SERVICES } from './services'

interface ProspectionControlsProps {
  view: ProspectionView
  // Applies a patch to the URL view and goes back to page 1.
  onChange: (patch: Partial<ProspectionView>) => void
  // The page's search box (entity-specific placeholder), first of the row.
  search: ReactNode
}

// One control row: [search] [Trier par] [Filtres] | [applied filters] (ui/ControlBar). Filters never change the entity:
// they only restrict its list. Each takes several values (any of them), the filters combine; the panel applies on
// « Valider ». Every applied value is a removable chip (filterChips.ts) and lives in the URL.
export function ProspectionControls({ view, onChange, search }: ProspectionControlsProps) {
  return (
    <ControlBar
      search={search}
      sort={<SortControl view={view} onChange={onChange} />}
      filters={<FiltersMenu view={view} onChange={onChange} />}
      active={<ActiveFilters view={view} onChange={onChange} />}
    />
  )
}

function SortControl({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  return (
    <SortSelect
      value={sortFor(view)}
      options={ENTITY_SORTS[view.entity].map((sort) => ({ value: sort, label: view.entity !== 'prospect' && sort === 'updated' ? 'Dernière modification' : SORT_LABELS[sort] }))}
      onChange={(sort) => { onChange({ sort: sort as ViewSort }) }}
    />
  )
}

// « S39 — 28 sept. 2026 », « S0 — hors campagne ».
function cohortOption(cohort: Cohort): string {
  if (cohort.out_of_campaign) return `${cohort.code} — hors campagne`
  return cohort.starts_on ? `${cohort.code} — ${formatDay(cohort.starts_on)}` : cohort.code
}

// The picked records are shown by name, from the lists the filters load.
function ActiveFilters({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  const roles = useTaxonomyValues('roles')
  const segments = useTaxonomyValues('commercial-segments')
  const categories = useTaxonomyValues('activity-categories')
  const cohorts = useCohorts()
  const referents = useReferents()
  const options = useFilterOptions()
  const imports = useImportHistory()
  const names: FilterNames = {
    role: (id) => roles.data?.find((role) => role.id === id)?.label,
    commercial_segment: (id) => segments.data?.find((segment) => segment.id === id)?.label,
    activity_category: (id) => categories.data?.find((category) => category.id === id)?.label,
    cohort: (id) => cohorts.data?.find((cohort) => cohort.id === id)?.code,
    referent: (id) => { const referent = referents.data?.find((item) => item.id === id); return referent ? referentName(referent) : undefined },
    company: (id) => options.data?.companies.find((company) => company.id === id)?.label,
    import_batch: (id) => imports.data?.find((batch) => batch.id === id)?.filename,
  }
  const chips = activeFilters(view, names).map((chip) => ({ id: chip.id, label: chip.label, onRemove: () => { onChange(chip.clear) } }))
  return <ActiveChips chips={chips} onClear={() => { onChange(clearedFilters(view.entity)) }} />
}

interface FieldsProps {
  // The selection being made, not yet applied.
  draft: ProspectionView
  patch: (changes: Partial<ProspectionView>) => void
}

function periodRefusal({ created_from: from, created_to: to }: ProspectionView): string | null {
  return from && to && to < from ? 'La fin précède le début.' : null
}

// « Filtres »: the choices of the entity shown. Short lists are toggles, long ones searchable pickers.
function FiltersMenu({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  const Fields = { prospect: ProspectFields, company: CompanyFields, warehouse: WarehouseFields }[view.entity]
  return (
    <ApplyFilterMenu
      key={view.entity}
      count={activeFilters(view).length}
      applied={view}
      cleared={clearedFilters(view.entity)}
      onApply={onChange}
      refuse={periodRefusal}
    >
      {(draft, patch, open) => open && <Fields draft={draft} patch={patch} />}
    </ApplyFilterMenu>
  )
}

function choices<T extends string>(values: readonly T[], labels: Record<T, string>): MultiSelectOption<T>[] {
  return values.map((value) => ({ value, label: labels[value] }))
}

const STATUS_TONES = { verified: 'success', usable: 'info', incomplete: 'warning', ignored: 'danger' } as const
const REVIEW_CHOICES = REVIEWS.map((status) => ({ value: status, label: REVIEW_INFO[status].label, hint: REVIEW_INFO[status].hint, tone: STATUS_TONES[status] }))
const SERVICE_CHOICES: MultiSelectOption<string>[] = SERVICES.map((service) => ({ value: service.code, label: service.label }))
// « Mis de côté » is the status « Ignoré » above: offered once.
const BOX_CHOICES = choices(VERIFICATION_BOXES.filter((box) => box !== 'ignored'), BOX_LABELS)

function CompanyKindChoice({ draft, patch }: FieldsProps) {
  return <MultiSelect label="Type d’entreprise" options={choices(COMPANY_KIND_FILTERS, COMPANY_KIND_CHOICES)} value={draft.company_kind} onChange={(company_kind) => { patch({ company_kind }) }} />
}

function FileStatusChoice({ entity, draft, patch }: FieldsProps & { entity: 'company' | 'warehouse' }) {
  const options = FILE_STATUSES.map((status) => ({ value: status, label: FILE_STATUS_LABELS[status], hint: FILE_STATUS_HINTS[entity][status], tone: STATUS_TONES[status] }))
  return <MultiSelect label="Statut de la fiche" options={options} value={draft.file_status} onChange={(file_status) => { patch({ file_status }) }} />
}

interface PickerProps {
  label: string
  placeholder: string
  options: ComboboxOption[]
  value: string[]
  onChange: (value: string[]) => void
  source?: { isError: boolean; isPending: boolean; refetch: () => unknown }
}

// A long list: the shared searchable multi picker, with its loading and failure states.
function Picker({ label, placeholder, options, value, onChange, source }: PickerProps) {
  // A selected value the list no longer offers stays visible and removable.
  const missing = value.filter((id) => !options.some((option) => option.id === id))
  return (
    <div>
      <Combobox
        multiple
        label={label}
        placeholder={value.length === 0 ? placeholder : undefined}
        options={[...options, ...missing.map((id) => ({ id, label: 'Valeur sélectionnée' }))]}
        status={source?.isError ? 'error' : source?.isPending ? 'loading' : 'ready'}
        value={value}
        onChange={onChange}
      />
      {source?.isError && (
        <p className="filters-menu__refusal" role="alert">
          Liste « {label} » indisponible. <Button size="sm" variant="ghost" onClick={() => { void source.refetch() }}>Réessayer</Button>
        </p>
      )}
    </div>
  )
}

function none(key: keyof typeof NONE_LABELS): ComboboxOption {
  return { id: NONE, label: NONE_LABELS[key] }
}

// The company's activity, commercial segment and departments (Prospects and Entreprises alike).
function CompanyPickers({ draft, patch }: FieldsProps) {
  const categories = useTaxonomyValues('activity-categories')
  const segments = useTaxonomyValues('commercial-segments')
  const options = useFilterOptions()
  const taxonomy = (values: typeof categories.data) => (values ?? []).map((value) => ({ id: value.id, label: value.active ? value.label : `${value.label} (inactif)` }))
  return (
    <>
      <Picker label="Secteur d’activité" placeholder="Tous les secteurs" source={categories} options={[none('activity_category'), ...taxonomy(categories.data)]} value={draft.activity_category} onChange={(activity_category) => { patch({ activity_category }) }} />
      <Picker label="Segment commercial" placeholder="Tous les segments" source={segments} options={[none('commercial_segment'), ...taxonomy(segments.data)]} value={draft.commercial_segment} onChange={(commercial_segment) => { patch({ commercial_segment }) }} />
      <DepartmentPicker draft={draft} patch={patch} departments={options.data?.company_departments} source={options} />
    </>
  )
}

function DepartmentPicker({ draft, patch, departments, source }: FieldsProps & { departments: string[] | undefined; source: PickerProps['source'] }) {
  return <Picker label="Département" placeholder="Tous les départements" source={source} options={(departments ?? []).map((code) => ({ id: code, label: code }))} value={draft.department} onChange={(department) => { patch({ department }) }} />
}

// Monday and Sunday (ISO dates) of the week of `today`.
function currentWeek(today: string): { from: string; to: string } {
  const day = new Date(`${today}T12:00:00Z`)
  const monday = new Date(day.getTime() - ((day.getUTCDay() || 7) - 1) * 86_400_000)
  const sunday = new Date(monday.getTime() + 6 * 86_400_000)
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) }
}

function CreationDates({ draft, patch }: FieldsProps) {
  const week = currentWeek(businessToday())
  const thisWeek = draft.created_from === week.from && draft.created_to === week.to
  return (
    <div className="filters-menu__fields" role="group" aria-label="Date d’ajout">
      <TextField label="Ajoutés depuis le" type="date" value={draft.created_from ?? ''} onChange={(event) => { patch({ created_from: calendarDate(event.target.value) }) }} />
      <TextField label="Ajoutés jusqu’au" type="date" value={draft.created_to ?? ''} onChange={(event) => { patch({ created_to: calendarDate(event.target.value) }) }} />
      <div className="filters-menu__week">
        <Button size="sm" aria-pressed={thisWeek} variant={thisWeek ? 'primary' : 'secondary'} onClick={() => { patch(thisWeek ? { created_from: null, created_to: null } : { created_from: week.from, created_to: week.to }) }}>
          Cette semaine
        </Button>
      </div>
    </div>
  )
}

// Values come from Paramètres (roles, referents, cohorts = campagnes, taxonomies), the companies and the import
// history; « Sans … » options select people with no value (« Sans semaine de contact » : not validated).
function ProspectFields({ draft, patch }: FieldsProps) {
  const roles = useTaxonomyValues('roles')
  const cohorts = useCohorts()
  const referents = useReferents()
  const options = useFilterOptions()
  const imports = useImportHistory()
  const batches = (imports.data ?? []).filter((batch) => batch.status === 'committed')

  return (
    <>
      <MultiSelect label="Statut du prospect" options={REVIEW_CHOICES} value={draft.review} onChange={(review) => { patch({ review }) }} />
      <MultiSelect label="État commercial" options={choices(TRACKING_STATUSES, TRACKING_LABELS)} value={draft.tracking_status.filter((status) => status !== NONE)} onChange={(tracking_status) => { patch({ tracking_status }) }} />
      <MultiSelect label="Activité" options={choices(ACTIVITIES, ACTIVITY_LABELS)} value={draft.activity} onChange={(activity) => { patch({ activity }) }} />
      <MultiSelect label="Validation de l’emploi" options={BOX_CHOICES} value={draft.verification_box} onChange={(verification_box) => { patch({ verification_box }) }} />
      <MultiSelect label="E-mail principal" options={choices(EMAIL_STATES, EMAIL_STATE_LABELS)} value={draft.email_state} onChange={(email_state) => { patch({ email_state }) }} />
      <MultiSelect label="Envois réalisés" options={choices(SEND_STAGES, SEND_STAGE_LABELS)} value={draft.send_stage} onChange={(send_stage) => { patch({ send_stage }) }} />
      <CompanyKindChoice draft={draft} patch={patch} />
      <MultiSelect label="Services identifiés" options={SERVICE_CHOICES} value={draft.services} onChange={(services) => { patch({ services }) }} />
      <div className="filters-menu__fields" role="group" aria-label="Filtres avancés">
        <Picker label="Rôle" placeholder="Tous les rôles" source={roles} options={[none('role'), ...(roles.data ?? []).map((role) => ({ id: role.id, label: role.active ? role.label : `${role.label} (inactif)` }))]} value={draft.role} onChange={(role) => { patch({ role }) }} />
        <Picker label="Entreprise" placeholder="Toutes les entreprises" source={options} options={options.data?.companies ?? []} value={draft.company} onChange={(company) => { patch({ company }) }} />
        <Picker label="Semaine de contact" placeholder="Toutes les semaines" source={cohorts} options={[none('cohort'), ...(cohorts.data ?? []).map((cohort) => ({ id: cohort.id, label: cohortOption(cohort) }))]} value={draft.cohort} onChange={(cohort) => { patch({ cohort }) }} />
        <Picker label="Référent" placeholder="Tous les référents" source={referents} options={[none('referent'), ...(referents.data ?? []).map((referent) => ({ id: referent.id, label: referentName(referent) }))]} value={draft.referent} onChange={(referent) => { patch({ referent }) }} />
        <CompanyPickers draft={draft} patch={patch} />
        <Picker label="Import" placeholder="Tous les imports" source={imports} options={batches.map((batch) => ({ id: batch.id, label: `${batch.filename} — ${formatDay(batch.committed_at ?? batch.created_at)}` }))} value={draft.import_batch} onChange={(import_batch) => { patch({ import_batch }) }} />
      </div>
      <CreationDates draft={draft} patch={patch} />
      <Switch
        label="Afficher les ignorés"
        hint="Personnes ayant décliné ou demandé à ne plus être contactées : masquées par défaut."
        checked={draft.include_ignored ?? false}
        onChange={(event) => { patch({ include_ignored: event.target.checked }) }}
      />
      <ArchivedSwitch draft={draft} patch={patch} />
    </>
  )
}

function CompanyFields({ draft, patch }: FieldsProps) {
  return (
    <>
      <CompanyKindChoice draft={draft} patch={patch} />
      <FileStatusChoice entity="company" draft={draft} patch={patch} />
      <MultiSelect label="Services identifiés" options={SERVICE_CHOICES} value={draft.services} onChange={(services) => { patch({ services }) }} />
      <div className="filters-menu__fields" role="group" aria-label="Filtres avancés">
        <CompanyPickers draft={draft} patch={patch} />
      </div>
      <CreationDates draft={draft} patch={patch} />
      <ArchivedSwitch draft={draft} patch={patch} />
    </>
  )
}

function ArchivedSwitch({ draft, patch }: FieldsProps) {
  return (
    <Switch
      label="Afficher les archivés"
      checked={draft.include_archived ?? false}
      onChange={(event) => { patch({ include_archived: event.target.checked }) }}
    />
  )
}

function WarehouseFields({ draft, patch }: FieldsProps) {
  const options = useFilterOptions()
  return (
    <>
      <MultiSelect label="Catégorie" options={choices(WAREHOUSE_CATEGORIES, WAREHOUSE_CATEGORY_LABELS)} value={draft.warehouse_category} onChange={(warehouse_category) => { patch({ warehouse_category }) }} />
      <FileStatusChoice entity="warehouse" draft={draft} patch={patch} />
      <Switch
        label="À contacter"
        hint="Interlocuteurs marqués « à contacter » ; la liste montre leurs entrepôts."
        checked={draft.warehouse_to_contact}
        onChange={(event) => { patch({ warehouse_to_contact: event.target.checked }) }}
      />
      <div className="filters-menu__fields" role="group" aria-label="Filtres avancés">
        <DepartmentPicker draft={draft} patch={patch} departments={options.data?.warehouse_departments} source={options} />
      </div>
      <CreationDates draft={draft} patch={patch} />
    </>
  )
}
