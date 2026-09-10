// What the Prospection list shows lives in the URL (`/prospection?segment=due&q=…&page=2`), so refresh, browser Back
// and deep links (Home, Task 16) restore it. Parameter names are the API's; defaults are omitted.
import {
  type ActivityStatus,
  NONE,
  PROSPECT_SORTS,
  type ProspectListCriteria,
  type ProspectSort,
  SEGMENTS,
  type Segment,
  TRACKING_STATUSES,
  type TrackingStatus,
} from '../api/prospection'

export interface ProspectionView extends ProspectListCriteria {
  page: number
  // Open prospect (`?prospect=<id>`, or `new` for « Ajouter un prospect ») — the editor contract (prospectEditor.tsx).
  prospect: string | null
}

export const DEFAULT_VIEW: ProspectionView = {
  segment: 'all',
  q: '',
  role: null,
  activity: null,
  referent: null,
  tracking_status: null,
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
    segment: oneOf<Segment>(SEGMENTS, params.get('segment')) ?? 'all',
    q: params.get('q') ?? '',
    role: id(params.get('role'), { allowNone: true }),
    activity: oneOf(ACTIVITIES, params.get('activity')) as ActivityStatus | null,
    referent: id(params.get('referent'), { allowNone: true }),
    tracking_status:
      params.get('tracking_status') === NONE ? NONE : oneOf<TrackingStatus>(TRACKING_STATUSES, params.get('tracking_status')),
    company: id(params.get('company')),
    import_batch: id(params.get('import_batch')),
    sort: oneOf<ProspectSort>(PROSPECT_SORTS, params.get('sort')) ?? 'name',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    prospect: prospect === 'new' ? 'new' : id(prospect),
  }
}

export function serializeView(view: Partial<ProspectionView>): URLSearchParams {
  const full = { ...DEFAULT_VIEW, ...view }
  const params = new URLSearchParams()
  for (const key of Object.keys(DEFAULT_VIEW) as (keyof ProspectionView)[]) {
    const value = full[key]
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
export function hasFilters(view: ProspectionView): boolean {
  return (
    view.q.trim() !== '' ||
    [view.role, view.activity, view.referent, view.tracking_status, view.company, view.import_batch].some(
      (value) => value !== null,
    )
  )
}
