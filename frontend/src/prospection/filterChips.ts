// The model of « Filtres » : every applied value of every filter of the entity shown is one removable chip with a French
// label. A chip is plain data (`clear` = the patch that removes it from the URL view); ENTITY_FILTER_KEYS (criteria.ts)
// decides which filters belong to which entity, so a filter of another entity never shows up here. The labels of the
// fixed choices are here too: the panel (ProspectionFilters.tsx) and the chips say the same words.
import { COMPANY_KIND_LABELS } from '../api/companies'
import { FILE_STATUS_LABELS } from '../api/fileStatus'
import { type CompanyKindFilter, type EmailState, NONE, type SendStage, type VerificationBox } from '../api/prospection'
import { ENTITY_FILTER_KEYS, type ProspectionView, type WarehouseCategory } from './criteria'
import { ACTIVITY_LABELS, formatDay, REVIEW_INFO, SEGMENT_INFO, TRACKING_LABELS } from './labels'
import { SERVICES } from './services'

export interface FilterChip {
  id: string
  label: string
  clear: Partial<ProspectionView>
}

// Names of the picked records — resolved by the component that loaded them.
export interface FilterNames {
  role: (id: string) => string | undefined
  referent: (id: string) => string | undefined
  cohort: (id: string) => string | undefined
  company: (id: string) => string | undefined
  import_batch: (id: string) => string | undefined
  commercial_segment: (id: string) => string | undefined
  activity_category: (id: string) => string | undefined
}

const unknown = () => undefined
export const NO_NAMES: FilterNames = { role: unknown, referent: unknown, cohort: unknown, company: unknown, import_batch: unknown, commercial_segment: unknown, activity_category: unknown }

export const COMPANY_KIND_CHOICES: Record<CompanyKindFilter, string> = { ...COMPANY_KIND_LABELS, unclassified: 'À classer' }
export const WAREHOUSE_CATEGORY_LABELS: Record<WarehouseCategory, string> = { sme: 'PME/TPE', other: 'Autres', unclassified: 'À classer' }
export const BOX_LABELS: Record<VerificationBox, string> = { validated: 'Emploi validé', uncertain: 'Incertain', todo: 'À vérifier', ignored: 'Mis de côté' }
export const SEND_STAGE_LABELS: Record<SendStage, string> = { sent: 'Premier envoi', r1: 'Relance 1', r2: 'Relance 2' }
export const EMAIL_STATE_LABELS: Record<EmailState, string> = { verified: 'Vérifié', unverified: 'Non vérifié', invalid: 'Invalide', missing: 'Manquant' }
// « Sans … »: the choice selecting no value.
export const NONE_LABELS = {
  role: 'Sans rôle',
  referent: 'Sans référent',
  cohort: 'Sans semaine de contact',
  commercial_segment: 'Sans segment',
  activity_category: 'Sans secteur d’activité',
} as const

function createdChip(view: ProspectionView): FilterChip[] {
  const { created_from: from, created_to: to } = view
  if (!from && !to) return []
  const label = from && to ? `Ajoutés du ${formatDay(from)} au ${formatDay(to)}` : from ? `Ajoutés depuis le ${formatDay(from)}` : `Ajoutés jusqu’au ${formatDay(to ?? '')}`
  return [{ id: 'created', label, clear: { created_from: null, created_to: null } }]
}

export function activeFilters(view: ProspectionView, names: FilterNames = NO_NAMES): FilterChip[] {
  const chips: FilterChip[] = []
  const keys: readonly (keyof ProspectionView)[] = ENTITY_FILTER_KEYS[view.entity]
  const add = (id: string, label: string, clear: Partial<ProspectionView>) => chips.push({ id, label, clear })
  // One chip per chosen value of a filter of this entity; removing it keeps the others.
  const each = <T extends string>(key: keyof ProspectionView, selected: readonly T[], label: (value: T) => string) => {
    if (!keys.includes(key)) return
    for (const value of selected) add(`${key}-${value}`, label(value), { [key]: selected.filter((item) => item !== value) })
  }
  const named = (key: keyof typeof NONE_LABELS, prefix: string, fallback: string) => {
    each(key, view[key], (value) => (value === NONE ? NONE_LABELS[key] : `${prefix} : ${names[key](value) ?? fallback}`))
  }
  if (view.entity === 'prospect') {
    if (view.include_ignored) add('include_ignored', 'Ignorés inclus', { include_ignored: false })
    if (view.include_archived) add('include_archived', 'Archivés inclus', { include_archived: false })
    if (view.identity_doubt) add('identity_doubt', 'Identité e-mail à vérifier', { identity_doubt: false })
    if (view.validated_only) add('validated_only', 'Emploi validé', { validated_only: false })
    each('verification_box', view.verification_box, (box) => BOX_LABELS[box])
    each('review', view.review, (status) => REVIEW_INFO[status].label)
    if (view.segment !== 'all') add('segment', SEGMENT_INFO[view.segment].label, { segment: 'all' })
  }
  if (view.entity === 'warehouse') {
    each('warehouse_category', view.warehouse_category, (category) => `Catégorie : ${WAREHOUSE_CATEGORY_LABELS[category]}`)
    if (view.warehouse_to_contact) add('warehouse_to_contact', 'À contacter', { warehouse_to_contact: false })
  }
  each('file_status', view.file_status, (status) => `Statut : ${FILE_STATUS_LABELS[status]}`)
  chips.push(...createdChip(view))
  each('company_kind', view.company_kind, (kind) => `Type : ${COMPANY_KIND_CHOICES[kind]}`)
  named('role', 'Rôle', 'sélectionné')
  each('activity', view.activity, (activity) => `Activité : ${ACTIVITY_LABELS[activity]}`)
  named('referent', 'Référent', 'sélectionné')
  each('tracking_status', view.tracking_status, (status) => (status === NONE ? 'Sans état commercial' : `État : ${TRACKING_LABELS[status]}`))
  named('cohort', 'Semaine de contact', 'sélectionnée')
  each('company', view.company, (id) => `Entreprise : ${names.company(id) ?? 'sélectionnée'}`)
  each('import_batch', view.import_batch, (id) => `Import : ${names.import_batch(id) ?? 'sélectionné'}`)
  named('activity_category', 'Secteur', 'sélectionné')
  named('commercial_segment', 'Segment', 'sélectionné')
  each('department', view.department, (code) => `Département : ${code}`)
  each('services', view.services, (code) => `Service : ${SERVICES.find((service) => service.code === code)?.label ?? code}`)
  each('send_stage', view.send_stage, (stage) => `Envoi : ${SEND_STAGE_LABELS[stage]}`)
  each('email_state', view.email_state, (state) => `E-mail : ${EMAIL_STATE_LABELS[state]}`)
  return chips
}
