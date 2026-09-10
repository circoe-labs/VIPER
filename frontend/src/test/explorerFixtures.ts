// Synthetic Database Explorer API payloads for tests. Every value is invented.
import type { ExplorerColumn, ExplorerRow, ExplorerRowPage, ExplorerTable, ExplorerTableSummary } from '../api/explorer'

const TEXT_OPS: ExplorerColumn['filter_operators'] = ['contains', 'eq', 'neq', 'starts_with', 'in', 'is_null', 'not_null']
const UUID_OPS: ExplorerColumn['filter_operators'] = ['eq', 'neq', 'in', 'starts_with', 'is_null', 'not_null']

export function column(name: string, overrides: Partial<ExplorerColumn> = {}): ExplorerColumn {
  return {
    name,
    sql_type: 'varchar(255)',
    kind: 'text',
    nullable: true,
    default: null,
    primary_key: false,
    foreign_key: null,
    allowed_values: null,
    masked: false,
    filter_operators: TEXT_OPS,
    sortable: true,
    searchable: true,
    ...overrides,
  }
}

export const idColumn = column('id', {
  sql_type: 'uuid',
  kind: 'uuid',
  nullable: false,
  default: 'gen_random_uuid()',
  primary_key: true,
  filter_operators: UUID_OPS,
})

export const COMPANY_IDS = ['01a00000-0000-7000-8000-000000000001', '01a00000-0000-7000-8000-000000000002']
export const PROSPECT_ID = '01a00000-0000-7000-8000-0000000000a1'
export const LONG_TEXT = 'Texte fictif très long. '.repeat(30)

export const companiesTable: ExplorerTable = {
  name: 'companies',
  row_count: 2,
  primary_key: ['id'],
  columns: [
    idColumn,
    column('display_name', { nullable: false }),
    column('size_label', { sql_type: 'varchar(100)' }),
    column('client_approach', { sql_type: 'text' }),
    column('rows_total', { sql_type: 'integer', kind: 'integer', filter_operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'not_null'] }),
  ],
  referenced_by: [{ table: 'prospects', column: 'company_id', referenced_column: 'id' }],
}

export const prospectsTable: ExplorerTable = {
  name: 'prospects',
  row_count: 1,
  primary_key: ['id'],
  columns: [
    idColumn,
    column('company_id', { sql_type: 'uuid', kind: 'uuid', foreign_key: { table: 'companies', column: 'id' }, filter_operators: UUID_OPS }),
    column('last_name'),
    column('activity_status', {
      sql_type: 'varchar(32)',
      kind: 'enum',
      nullable: false,
      allowed_values: ['active', 'inactive', 'unknown'],
      filter_operators: ['eq', 'neq', 'in', 'is_null', 'not_null'],
    }),
    column('legacy_metadata', { sql_type: 'jsonb', kind: 'json', filter_operators: ['contains', 'is_null', 'not_null'] }),
  ],
  referenced_by: [],
}

export const TABLES: ExplorerTableSummary[] = [
  { name: 'companies', row_count: 2 },
  { name: 'prospects', row_count: 1 },
  { name: 'roles', row_count: 4 },
]

export const companyRows: ExplorerRow[] = [
  {
    values: {
      id: COMPANY_IDS[0],
      display_name: 'Transports Exemple SARL',
      size_label: null,
      client_approach: LONG_TEXT.slice(0, 240),
      rows_total: 12,
    },
    truncated: ['client_approach'],
  },
  {
    values: { id: COMPANY_IDS[1], display_name: 'Logistique Démo SAS', size_label: '10-49', client_approach: null, rows_total: 3 },
    truncated: [],
  },
]

export const prospectRows: ExplorerRow[] = [
  {
    values: {
      id: PROSPECT_ID,
      company_id: COMPANY_IDS[1],
      last_name: 'Test',
      activity_status: 'active',
      legacy_metadata: { 'Colonne inconnue': 'valeur fictive' },
    },
    truncated: [],
  },
]

export function page(rows: ExplorerRow[], total = rows.length, offset = 0, limit = 100): ExplorerRowPage {
  return { total, offset, limit, rows }
}
