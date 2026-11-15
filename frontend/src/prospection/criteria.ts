// What the Prospection list shows lives in the URL (`/prospection?segment=due&q=…&page=2`), so refresh, browser Back
// and deep links (Home, Task 16) restore it. Parameter names are the API's; defaults are omitted.
import { FILE_STATUSES, type FileStatus } from '../api/fileStatus'
import {
  type ActivityStatus,
  NONE,
  PROSPECT_SORTS,
  REVIEWS,
  type ProspectListCriteria,
  type Review,
  type ProspectSort,
  SEGMENTS,
  type Segment,
  TRACKING_STATUSES,
  type TrackingStatus,
} from '../api/prospection'
import { calendarDate } from '../lib/calendarDate'

// The entity selector (Prospects / Entreprises / Entrepôts) drives the whole page: `?entity=company|warehouse`
// (`prospect`, the default, is omitted). `q`, `page` and `company_kind` are shared across entities; the two
// warehouse filters below only apply to `entity=warehouse`.
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
  file_status: FileStatus | null
  // `?warehouse_category=sme|other|unclassified` and `?warehouse_to_contact=true` (entity=warehouse).
  warehouse_category: WarehouseCategory | null
  warehouse_to_contact: boolean
  page: number
  // Open prospect (`?prospect=<id>`, or `new` for « Ajouter un prospect ») — the editor contract (prospectEditor.tsx).
  prospect: string | null
}

export const DEFAULT_VIEW: ProspectionView = {
  entity: 'prospect',
  warehouse_category: null,
  warehouse_to_contact: false,
  include_ignored: false,
  file_status: null,
  validated_only: false,
  verification_box: null,
  created_from: null,
  created_to: null,
  services: [],
  send_stage: null,
  company_kind: null,
  segment: 'all',
  review: null,
  q: '',
  role: null,
  activity: null,
  referent: null,
  tracking_status: null,
  cohort: null,
  company: null,
  import_batch: null,
  sort: 'name',
  page: 1,
  prospect: null,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIVITIES: readonly string[] = ['active', 'unknown', 'inactive']

function oneOf<T extends string>(values: readonly T[], raw: string | null): T | null {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : null
}

function id(raw: string | null, { allowNone = false } = {}): string | null {
  if (raw === null) return null
  if (allowNone && raw === NONE) return NONE
  return UUID.test(raw) ? raw.toLowerCase() : null
}

// Hand-edited or stale URLs never break the page: anything malformed falls back to its default.
export function parseView(params: URLSearchParams): ProspectionView {
  const page = Number(params.get('page'))
  const prospect = params.get('prospect')
  return {
    entity: oneOf<Entity>(ENTITIES, params.get('entity')) ?? 'prospect',
    warehouse_category: oneOf<WarehouseCategory>(WAREHOUSE_CATEGORIES, params.get('warehouse_category')),
    warehouse_to_contact: params.get('warehouse_to_contact') === 'true',
    include_ignored: params.get('include_ignored') === 'true',
    file_status: oneOf<FileStatus>(FILE_STATUSES, params.get('file_status')),
    validated_only: params.get('validated_only') === 'true',
    verification_box: oneOf(['validated', 'uncertain', 'todo', 'ignored'] as const, params.get('verification_box')),
    created_from: calendarDate(params.get('created_from')),
    created_to: calendarDate(params.get('created_to')),
    services: [...new Set(params.getAll('services').filter((code) => ['iguard', 'flexisme', 'transepteur', 'iadvice', 'emailing'].includes(code)))].sort(),
    send_stage: oneOf(['sent', 'r1', 'r2'] as const, params.get('send_stage')),
    company_kind: oneOf(['sme', 'large', 'institutional', 'unclassified'] as const, params.get('company_kind')),
    segment: oneOf<Segment>(SEGMENTS, params.get('segment')) ?? 'all',
    review: oneOf<Review>(REVIEWS, params.get('review')),
    q: params.get('q') ?? '',
    role: id(params.get('role'), { allowNone: true }),
    activity: oneOf(ACTIVITIES, params.get('activity')) as ActivityStatus | null,
    referent: id(params.get('referent'), { allowNone: true }),
    tracking_status:
      params.get('tracking_status') === NONE ? NONE : oneOf<TrackingStatus>(TRACKING_STATUSES, params.get('tracking_status')),
    cohort: id(params.get('cohort'), { allowNone: true }),
    company: id(params.get('company')),
    import_batch: id(params.get('import_batch')),
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
  return view.segment !== 'all' || view.review !== null
}

export function hasFilters(view: ProspectionView): boolean {
  return (
    !!view.validated_only ||
    !!view.verification_box ||
    view.q.trim() !== '' ||
    !!view.created_from || !!view.created_to ||
    (view.services?.length ?? 0) > 0 || !!view.send_stage || !!view.company_kind ||
    [view.role, view.activity, view.referent, view.tracking_status, view.cohort, view.company, view.import_batch].some(
      (value) => value !== null,
    )
  )
}

// The sort the entity can honour: a value it does not know (« created » on prospects) falls back to the default.
export function sortFor(view: Pick<ProspectionView, 'entity' | 'sort'>): ViewSort {
  return ENTITY_SORTS[view.entity].includes(view.sort) ? view.sort : 'name'
}

// What a filter means is per entity: validated_only has no sense on Entreprises, the warehouse category none on
// Prospects. `ENTITY_FILTER_KEYS` is the single list; q and sort are shared (sort only when the entity knows it).
export const ENTITY_FILTER_KEYS: Record<Entity, readonly (keyof ProspectionView)[]> = {
  prospect: ['include_ignored', 'validated_only', 'verification_box', 'review', 'segment', 'created_from', 'created_to', 'company_kind', 'role', 'activity', 'referent', 'tracking_status', 'cohort', 'company', 'import_batch', 'services', 'send_stage'],
  company: ['company_kind', 'created_from', 'created_to', 'file_status'],
  warehouse: ['warehouse_category', 'warehouse_to_contact', 'file_status'],
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

// Criteria narrowing the Entreprises list (type, search, creation period) and the Entrepôts list (category, to contact, search).
export function hasEntityFilters(view: ProspectionView): boolean {
  if (view.entity === 'company') return view.company_kind !== null || view.file_status !== null || view.q.trim() !== '' || !!view.created_from || !!view.created_to
  if (view.entity === 'warehouse') return view.warehouse_category !== null || view.warehouse_to_contact || view.file_status !== null || view.q.trim() !== ''
  return hasFilters(view)
}
