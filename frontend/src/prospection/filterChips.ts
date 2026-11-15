// The model of « Filtres » : every applied filter of the entity shown is one removable chip with a French label.
// A chip is plain data (`clear` = the patch that removes it from the URL view); ENTITY_FILTER_KEYS (criteria.ts)
// decides which filters belong to which entity, so a filter of another entity never shows up here.
import { FILE_STATUS_HINTS, FILE_STATUS_LABELS, FILE_STATUSES } from '../api/fileStatus'
import { NONE, REVIEWS } from '../api/prospection'
import type { Entity, ProspectionView, WarehouseCategory } from './criteria'
import { ACTIVITY_LABELS, formatDay, REVIEW_INFO, SEGMENT_INFO, TRACKING_LABELS } from './labels'
import { SERVICES } from './services'

export interface FilterChip {
  id: string
  label: string
  clear: Partial<ProspectionView>
}

// Names of the picked records (role, referent, cohort, company, import) — resolved by the component that loaded them.
export interface FilterNames {
  role: (id: string) => string | undefined
  referent: (id: string) => string | undefined
  cohort: (id: string) => string | undefined
  company: (id: string) => string | undefined
  import_batch: (id: string) => string | undefined
}

export const NO_NAMES: FilterNames = { role: () => undefined, referent: () => undefined, cohort: () => undefined, company: () => undefined, import_batch: () => undefined }

const COMPANY_KIND_CHIP: Record<string, string> = { sme: 'PME', large: 'Grosse entreprise', institutional: 'Institutionnelle', unclassified: 'À classer' }
export const WAREHOUSE_CATEGORY_LABELS: Record<WarehouseCategory, string> = { sme: 'PME/TPE', other: 'Autres', unclassified: 'À classer' }
const BOX_LABELS = { validated: 'Validés', uncertain: 'Incertains', todo: 'À vérifier', ignored: 'Mis de côté' } as const
const SEND_STAGE_LABELS = { sent: 'Premier envoi', r1: 'Relance 1', r2: 'Relance 2' } as const

function picked(prefix: string, id: string, none: string, name: string | undefined, fallback: string): string {
  return id === NONE ? none : `${prefix} : ${name ?? fallback}`
}

function createdChip(view: ProspectionView): FilterChip[] {
  const { created_from: from, created_to: to } = view
  if (!from && !to) return []
  const label = from && to ? `Ajoutés du ${formatDay(from)} au ${formatDay(to)}` : from ? `Ajoutés depuis le ${formatDay(from)}` : `Ajoutés jusqu’au ${formatDay(to ?? '')}`
  return [{ id: 'created', label, clear: { created_from: null, created_to: null } }]
}

export function activeFilters(view: ProspectionView, names: FilterNames = NO_NAMES): FilterChip[] {
  const chips: FilterChip[] = []
  const add = (id: string, label: string, clear: Partial<ProspectionView>) => chips.push({ id, label, clear })
  const kind = () => {
    if (view.company_kind) add('company_kind', `Type : ${COMPANY_KIND_CHIP[view.company_kind] ?? view.company_kind}`, { company_kind: null })
  }
  const entity: Entity = view.entity
  if (entity === 'warehouse') {
    if (view.warehouse_category) add('warehouse_category', `Catégorie : ${WAREHOUSE_CATEGORY_LABELS[view.warehouse_category]}`, { warehouse_category: null })
    if (view.warehouse_to_contact) add('warehouse_to_contact', 'À contacter', { warehouse_to_contact: false })
    if (view.file_status) add('file_status', `Statut : ${FILE_STATUS_LABELS[view.file_status]}`, { file_status: null })
    return chips
  }
  if (entity === 'company') {
    kind()
    if (view.file_status) add('file_status', `Statut : ${FILE_STATUS_LABELS[view.file_status]}`, { file_status: null })
    chips.push(...createdChip(view))
    return chips
  }
  if (view.include_ignored) add('include_ignored', 'Ignorés inclus', { include_ignored: false })
  if (view.validated_only) add('validated_only', 'Emploi validé', { validated_only: false })
  if (view.verification_box) add('verification_box', BOX_LABELS[view.verification_box], { verification_box: null })
  if (view.review) add('review', REVIEW_INFO[view.review].label, { review: null })
  if (view.segment !== 'all') add('segment', SEGMENT_INFO[view.segment].label, { segment: 'all' })
  chips.push(...createdChip(view))
  kind()
  if (view.role) add('role', picked('Rôle', view.role, 'Sans rôle', names.role(view.role), 'sélectionné'), { role: null })
  if (view.activity) add('activity', `Activité : ${ACTIVITY_LABELS[view.activity]}`, { activity: null })
  if (view.referent) add('referent', picked('Référent', view.referent, 'Sans référent', names.referent(view.referent), 'sélectionné'), { referent: null })
  if (view.tracking_status) add('tracking_status', view.tracking_status === NONE ? 'Sans état commercial' : `État : ${TRACKING_LABELS[view.tracking_status]}`, { tracking_status: null })
  if (view.cohort) add('cohort', picked('Semaine de contact', view.cohort, 'Sans semaine de contact', names.cohort(view.cohort), 'sélectionnée'), { cohort: null })
  if (view.company) add('company', `Entreprise : ${names.company(view.company) ?? 'sélectionnée'}`, { company: null })
  if (view.import_batch) add('import_batch', `Import : ${names.import_batch(view.import_batch) ?? 'sélectionné'}`, { import_batch: null })
  if ((view.services ?? []).length > 0) add('services', `Services : ${(view.services ?? []).map((code) => SERVICES.find((service) => service.code === code)?.label ?? code).join(', ')}`, { services: [] })
  if (view.send_stage) add('send_stage', `Envoi : ${SEND_STAGE_LABELS[view.send_stage]}`, { send_stage: null })
  return chips
}

// The quick filters of an entity (few, one click, shown first inside « Filtres »). Choosing one replaces the others of
// the same group; choosing the active one removes it. They only ever restrict the list of their own entity.
export interface QuickFilter {
  id: string
  label: string
  hint: string
  active: (view: ProspectionView) => boolean
  apply: Partial<ProspectionView>
  clear: Partial<ProspectionView>
}

const NO_STATUS: Partial<ProspectionView> = { validated_only: false, verification_box: null, review: null, segment: 'all' }
const KIND_CLEAR: Partial<ProspectionView> = { company_kind: null }
const CATEGORY_CLEAR: Partial<ProspectionView> = { warehouse_category: null }

const TRACKING_CLEAR: Partial<ProspectionView> = { tracking_status: null }

// Contact status of a prospect, one click (prospects only): the API filters on `tracking_status`.
export const CONTACT_QUICK_FILTERS: readonly QuickFilter[] = (['response_received', 'appointment_obtained', 'not_interested', 'disqualified'] as const).map((status) => ({
  id: `tracking_${status}`,
  label: TRACKING_LABELS[status],
  hint: 'État commercial du prospect dans Contact',
  active: (view: ProspectionView) => view.tracking_status === status,
  apply: { tracking_status: status },
  clear: TRACKING_CLEAR,
}))

export const QUICK_FILTERS: Record<Entity, readonly QuickFilter[]> = {
  prospect: [
    ...REVIEWS.map((review): QuickFilter => ({
      id: review,
      label: REVIEW_INFO[review].label,
      hint: REVIEW_INFO[review].hint,
      active: (v) => v.review === review && !v.validated_only && !v.verification_box,
      apply: { ...NO_STATUS, review },
      clear: NO_STATUS,
    })),
  ],
  company: [
    { id: 'institutional', label: 'Institutionnelles', hint: 'Entreprises de type institutionnel', active: (v) => v.company_kind === 'institutional', apply: { company_kind: 'institutional' }, clear: KIND_CLEAR },
    { id: 'sme', label: 'PME', hint: 'Entreprises de type PME', active: (v) => v.company_kind === 'sme', apply: { company_kind: 'sme' }, clear: KIND_CLEAR },
    { id: 'large', label: 'Grosses entreprises', hint: 'Entreprises de type grande entreprise', active: (v) => v.company_kind === 'large', apply: { company_kind: 'large' }, clear: KIND_CLEAR },
    { id: 'unclassified', label: 'À classer', hint: 'Sans type : à renseigner dans la fiche entreprise', active: (v) => v.company_kind === 'unclassified', apply: { company_kind: 'unclassified' }, clear: KIND_CLEAR },
  ],
  warehouse: [
    { id: 'sme', label: 'PME/TPE', hint: 'Catégorie de prospection', active: (v) => v.warehouse_category === 'sme', apply: { warehouse_category: 'sme' }, clear: CATEGORY_CLEAR },
    { id: 'other', label: 'Autres', hint: 'Catégorie de prospection', active: (v) => v.warehouse_category === 'other', apply: { warehouse_category: 'other' }, clear: CATEGORY_CLEAR },
    { id: 'unclassified', label: 'À classer', hint: 'Catégorie de prospection', active: (v) => v.warehouse_category === 'unclassified', apply: { warehouse_category: 'unclassified' }, clear: CATEGORY_CLEAR },
    { id: 'to_contact', label: 'À contacter', hint: 'Interlocuteurs marqués « à contacter » ; la liste montre leurs entrepôts', active: (v) => v.warehouse_to_contact, apply: { warehouse_to_contact: true }, clear: { warehouse_to_contact: false } },
  ],
}

// « Statut de la fiche » of a company or a warehouse (verified / usable / incomplete), one click.
export const FILE_STATUS_QUICK_FILTERS: Record<'company' | 'warehouse', readonly QuickFilter[]> = {
  company: statusFilters('company'),
  warehouse: statusFilters('warehouse'),
}

function statusFilters(entity: 'company' | 'warehouse'): readonly QuickFilter[] {
  return FILE_STATUSES.map((status): QuickFilter => ({
    id: `file_status_${status}`,
    label: FILE_STATUS_LABELS[status],
    hint: FILE_STATUS_HINTS[entity][status],
    active: (v) => v.file_status === status,
    apply: { file_status: status },
    clear: { file_status: null },
  }))
}
