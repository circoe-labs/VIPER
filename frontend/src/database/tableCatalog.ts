// French labels and rail groups for the technical table names. Unknown tables still appear, under "Autres".

const GROUPS: { label: string; tables: Record<string, string> }[] = [
  {
    label: 'Prospects & contacts',
    tables: { prospects: 'Prospects', emails: 'E-mails', phones: 'Téléphones', prospect_sources: 'Provenances' },
  },
  {
    label: 'Entreprises',
    tables: {
      companies: 'Entreprises',
      establishments: 'Établissements',
      company_activity_categories: 'Catégories d’entreprise',
    },
  },
  {
    label: 'Suivi de contact',
    tables: { contact_tracking: 'Suivi de contact', contact_tracking_status_history: 'Historique des statuts' },
  },
  {
    label: 'Référentiels',
    tables: {
      roles: 'Rôles',
      commercial_segments: 'Segments commerciaux',
      activity_categories: 'Catégories d’activité',
      internal_referents: 'Référents internes',
    },
  },
  {
    label: 'Imports & journal',
    tables: { import_batches: 'Lots d’import', import_row_metadata: 'Lignes importées', audit_log: 'Journal d’audit' },
  },
]

const OTHER_GROUP = 'Autres'

export function tableLabel(name: string): string | undefined {
  return GROUPS.find((group) => name in group.tables)?.tables[name]
}

export function groupTables<T extends { name: string }>(tables: T[]): { label: string; tables: T[] }[] {
  const grouped = GROUPS.map(({ label, tables: names }) => ({
    label,
    tables: Object.keys(names).flatMap((name) => tables.filter((table) => table.name === name)),
  }))
  const others = tables.filter((table) => tableLabel(table.name) === undefined)
  return [...grouped, { label: OTHER_GROUP, tables: others }].filter((group) => group.tables.length > 0)
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

// Accent- and case-insensitive match on the technical name or the French label.
export function matchesTable(name: string, query: string): boolean {
  const needle = fold(query.trim())
  return !needle || fold(name).includes(needle) || fold(tableLabel(name) ?? '').includes(needle)
}
