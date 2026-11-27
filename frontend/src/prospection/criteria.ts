// What the Prospection list shows lives in the URL (`/prospection?segment=due&q=…&page=2`), so refresh, browser Back
// and deep links (Home, Task 16) restore it. Parameter names are the API's; defaults are omitted.
import { FILE_STATUSES, type FileStatus } from '../api/fileStatus'
import {
  COMPANY_KIND_FILTERS,
  EMAIL_STATES,
  NONE,
  PROSPECT_SORTS,
  REVIEWS,
  type ProspectListCriteria,
  type ProspectSort,
  SEGMENTS,
  type Segment,
  SEND_STAGES,
  TRACKING_STATUSES,
  VERIFICATION_BOXES,
} from '../api/prospection'
import { calendarDate } from '../lib/calendarDate'
import { SERVICES } from './services'

// The entity selector (Prospects / Entreprises / Entrepôts) drives the whole page: `?entity=company|warehouse`
// (`prospect`, the default, is omitted). A filter with several values repeats its parameter (`role=a&role=b`; a link
// with one value reads as a selection of one). Which filters an entity has: `ENTITY_FILTER_KEYS` below.
export const ENTITIES = ['prospect', 'company', 'warehouse'] as const
export type Entity = (typeof ENTITIES)[number]
export const WAREHOUSE_CATEGORIES = ['sme', 'other', 'unclassified'] as const
export type WarehouseCategory = (typeof WAREHOUSE_CATEGORIES)[number]

// `?sort=`: `name` (default), `created`, `updated` for every entity; prospects also keep the older orders of
// GET /prospection/prospects (company, next_due, verification, file).
export type ViewSort = ProspectSort | 'created'
export const VIEW_SORTS: readonly ViewSort[] = PROSPECT_SORTS
export const ENTITY_SORTS: Record<Entity, readonly ViewSort[]> = {
  prospect: PROSPECT_SORTS,
  company: ['name', 'created', 'updated'],
  warehouse: ['name', 'created', 'updated'],
}

export interface ProspectionView extends Omit<ProspectListCriteria, 'sort'> {
  sort: ViewSort
  entity: Entity
  // `?file_status=verified|usable|incomplete`: the file status of a company or a warehouse.
  file_status: FileStatus[]
  // `?warehouse_category=sme|other|unclassified` and `?warehouse_to_contact=true` (entity=warehouse).
  warehouse_category: WarehouseCategory[]
  warehouse_to_contact: boolean
  page: number
  // Open prospect (`?prospect=<id>`, or `new` for « Ajouter un prospect ») — the editor contract (prospectEditor.tsx).
  prospect: string | null
}

export const DEFAULT_VIEW: ProspectionView = {
  entity: 'prospect',
  warehouse_category: [],
  warehouse_to_contact: false,
  include_ignored: false,
  file_status: [],
  validated_only: false,
  verification_box: [],
  created_from: null,
  created_to: null,
  services: [],
  send_stage: [],
  email_state: [],
  company_kind: [],
  commercial_segment: [],
  activity_category: [],
  department: [],
  segment: 'all',
  review: [],
  q: '',
  role: [],
  activity: [],
  referent: [],
  tracking_status: [],
  cohort: [],
  company: [],
  import_batch: [],
  sort: 'name',
  page: 1,
  prospect: null,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ACTIVITIES = ['active', 'unknown', 'inactive'] as const

function oneOf<T extends string>(values: readonly T[], raw: string | null): T | null {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : null
}

function id(raw: string | null): string | null {
  return raw !== null && UUID.test(raw) ? raw.toLowerCase() : null
}

// The known values of a repeated parameter, in the order the choices are listed.
function several<T extends string>(values: readonly T[], params: URLSearchParams, key: string): T[] {
  const raw = params.getAll(key)
  return values.filter((value) => raw.includes(value))
}

function severalIds(params: URLSearchParams, key: string, { allowNone = false } = {}): string[] {
  const found = params.getAll(key).map((raw) => (allowNone && raw === NONE ? NONE : id(raw)))
  return [...new Set(found.filter((value) => value !== null))].sort()
}

const DEPARTMENT = /^(\d{2}|9[78]\d)$/
const SERVICE_CODES: readonly string[] = SERVICES.map((service) => service.code)

// Hand-edited or stale URLs never break the page: anything malformed falls back to its default.
export function parseView(params: URLSearchParams): ProspectionView {
  const page = Number(params.get('page'))
  const prospect = params.get('prospect')
  return {
    entity: oneOf<Entity>(ENTITIES, params.get('entity')) ?? 'prospect',
    warehouse_category: several<WarehouseCategory>(WAREHOUSE_CATEGORIES, params, 'warehouse_category'),
    warehouse_to_contact: params.get('warehouse_to_contact') === 'true',
    include_ignored: params.get('include_ignored') === 'true',
    file_status: several<FileStatus>(FILE_STATUSES, params, 'file_status'),
    validated_only: params.get('validated_only') === 'true',
    verification_box: several(VERIFICATION_BOXES, params, 'verification_box'),
    created_from: calendarDate(params.get('created_from')),
    created_to: calendarDate(params.get('created_to')),
    services: several(SERVICE_CODES, params, 'services').sort(),
    send_stage: several(SEND_STAGES, params, 'send_stage'),
    email_state: several(EMAIL_STATES, params, 'email_state'),
    company_kind: several(COMPANY_KIND_FILTERS, params, 'company_kind'),
    commercial_segment: severalIds(params, 'commercial_segment', { allowNone: true }),
    activity_category: severalIds(params, 'activity_category', { allowNone: true }),
    department: [...new Set(params.getAll('department').filter((code) => DEPARTMENT.test(code)))].sort(),
    segment: oneOf<Segment>(SEGMENTS, params.get('segment')) ?? 'all',
    review: REVIEWS.filter((status) => params.getAll('review').includes(status)),
    q: params.get('q') ?? '',
    role: severalIds(params, 'role', { allowNone: true }),
    activity: several(ACTIVITIES, params, 'activity'),
    referent: severalIds(params, 'referent', { allowNone: true }),
    tracking_status: several([...TRACKING_STATUSES, NONE], params, 'tracking_status'),
    cohort: severalIds(params, 'cohort', { allowNone: true }),
    company: severalIds(params, 'company'),
    import_batch: severalIds(params, 'import_batch'),
    // `planned_contact` (a link written before the sequences rework) reads as its successor.
    sort: oneOf<ViewSort>(VIEW_SORTS, params.get('sort') === 'planned_contact' ? 'next_due' : params.get('sort')) ?? 'name',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    prospect: prospect === 'new' ? 'new' : id(prospect),
  }
}

export function serializeView(view: Partial<ProspectionView>): URLSearchParams {
  const full = { ...DEFAULT_VIEW, ...view }
  const params = new URLSearchParams()
  for (const key of Object.keys(DEFAULT_VIEW) as (keyof ProspectionView)[]) {
    const value = full[key]
    if (Array.isArray(value)) {
      for (const code of [...value].sort()) params.append(key, code)
      continue
    }
    if (value !== DEFAULT_VIEW[key] && value !== null && value !== '') params.set(key, String(value))
  }
  return params
}

// Link into Prospection on a segment and/or criteria — for Home's counters (Task 16) and other pages.
export function prospectionHref(view: Partial<ProspectionView> = {}): string {
  const query = serializeView(view).toString()
  return `/prospection${query ? `?${query}` : ''}`
}

// Criteria other than the segment and the sort that narrow the list (shown as « Réinitialiser les filtres »).
// A segment (Home's deep links) or a panel narrows the list; « Réinitialiser » clears them with the filters.
export function hasSelection(view: ProspectionView): boolean {
  return view.segment !== 'all' || view.review.length > 0
}

function narrows(view: ProspectionView, key: keyof ProspectionView): boolean {
  const value = view[key]
  return Array.isArray(value) ? value.length > 0 : value !== DEFAULT_VIEW[key]
}

export function hasFilters(view: ProspectionView): boolean {
  const selection: readonly (keyof ProspectionView)[] = ['segment', 'review', 'include_ignored']
  return view.q.trim() !== '' || ENTITY_FILTER_KEYS.prospect.some((key) => !selection.includes(key) && narrows(view, key))
}

// The sort the entity can honour: a value it does not know (« created » on prospects) falls back to the default.
export function sortFor(view: Pick<ProspectionView, 'entity' | 'sort'>): ViewSort {
  return ENTITY_SORTS[view.entity].includes(view.sort) ? view.sort : 'name'
}

// What a filter means is per entity: validated_only has no sense on Entreprises, the warehouse category none on
// Prospects. `ENTITY_FILTER_KEYS` is the single list; q and sort are shared (sort only when the entity knows it).
export const ENTITY_FILTER_KEYS: Record<Entity, readonly (keyof ProspectionView)[]> = {
  prospect: ['include_ignored', 'validated_only', 'verification_box', 'review', 'segment', 'created_from', 'created_to', 'company_kind', 'role', 'activity', 'referent', 'tracking_status', 'cohort', 'company', 'import_batch', 'services', 'send_stage', 'email_state', 'commercial_segment', 'activity_category', 'department'],
  company: ['company_kind', 'created_from', 'created_to', 'file_status', 'services', 'commercial_segment', 'activity_category', 'department'],
  warehouse: ['warehouse_category', 'warehouse_to_contact', 'file_status', 'department', 'created_from', 'created_to'],
}

// The view after switching entity: the new entity starts from scratch except what both entities share (q, a known
// sort, and the filters they have in common). Switching to the entity already shown changes nothing but the page.
export function switchEntity(view: ProspectionView, entity: Entity): Partial<ProspectionView> {
  if (entity === view.entity) return { ...view, page: 1, prospect: null }
  const kept: Partial<ProspectionView> = { entity, q: view.q, sort: ENTITY_SORTS[entity].includes(view.sort) ? view.sort : 'name' }
  const patch = kept as Record<string, unknown>
  for (const key of ENTITY_FILTER_KEYS[entity]) if (ENTITY_FILTER_KEYS[view.entity].includes(key)) patch[key] = view[key]
  return kept
}

export function entityHref(view: ProspectionView, entity: Entity): string {
  return prospectionHref(switchEntity(view, entity))
}

// Filters currently narrowing the list of the entity shown (what « Aucun filtre » / « Tout effacer » talk about).
export function clearedFilters(entity: Entity): Partial<ProspectionView> {
  const patch: Record<string, unknown> = {}
  for (const key of ENTITY_FILTER_KEYS[entity]) patch[key] = DEFAULT_VIEW[key]
  return patch
}

// Criteria narrowing the list of the entity shown (its filters and the search).
export function hasEntityFilters(view: ProspectionView): boolean {
  if (view.entity === 'prospect') return hasFilters(view)
  return view.q.trim() !== '' || ENTITY_FILTER_KEYS[view.entity].some((key) => narrows(view, key))
}
