import type { CompanyHit, EstablishmentHit, ProspectHit, SearchGroup, SearchResults } from '../api/search'

// Synthetic answers of GET /api/search (backend/app/api/routes/search.py) for component tests. Matching and ranking
// are computed and tested in the backend; these only shape the contract. Invented values only.

let sequence = 0

function nextId(): string {
  sequence += 1
  return `00000000-0000-7000-9000-${String(sequence).padStart(12, '0')}`
}

export function prospectHit(label: string, fields: Partial<ProspectHit> = {}): ProspectHit {
  const id = fields.id ?? nextId()
  return {
    type: 'prospect',
    id,
    label,
    sublabel: null,
    match: { field: 'name', kind: 'prefix', value: null },
    badges: [],
    open: { editor: 'prospect', id },
    record: { table: 'prospects', id },
    company_id: null,
    company_name: null,
    ...fields,
  }
}

export function companyHit(label: string, fields: Partial<CompanyHit> = {}): CompanyHit {
  const id = fields.id ?? nextId()
  return {
    type: 'company',
    id,
    label,
    sublabel: null,
    match: { field: 'name', kind: 'prefix', value: null },
    badges: [],
    open: { editor: 'company', id },
    record: { table: 'companies', id },
    siren: null,
    email_domain: null,
    city: null,
    prospect_count: 0,
    ...fields,
  }
}

export function establishmentHit(label: string, company: CompanyHit, fields: Partial<EstablishmentHit> = {}) {
  const id = fields.id ?? nextId()
  const hit: EstablishmentHit = {
    type: 'establishment',
    id,
    label,
    sublabel: null,
    match: { field: 'siret', kind: 'exact', value: null },
    badges: [],
    open: { editor: 'company', id: company.id },
    record: { table: 'establishments', id },
    company_id: company.id,
    company_name: company.label,
    siret: null,
    ...fields,
  }
  return hit
}

export function searchResults(query: string, groups: SearchGroup[]): SearchResults {
  return { query, groups }
}

export function group(items: (ProspectHit | CompanyHit | EstablishmentHit)[], hasMore = false): SearchGroup {
  const [first] = items
  if (!first) throw new Error('A group has at least one result.')
  return { type: first.type, items, has_more: hasMore }
}
