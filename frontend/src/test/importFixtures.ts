import type {
  CommitResult,
  ImportBatch,
  ImportReview,
  PreviewResult,
  PreviewRow,
  RowReview,
} from '../api/imports'

// Synthetic import review for component tests, shaped like the backend's `PreviewOut` (review.py). Every value is
// invented (example.com, fictitious people and companies).

const FINGERPRINT = 'a'.repeat(64)
const DIGEST = 'b'.repeat(64)
export const LUC_ID = '00000000-0000-7000-8000-00000000c001'
export const BLOCKED_ID = '00000000-0000-7000-8000-00000000c002'

function row(number: number, fields: Partial<PreviewRow> = {}): PreviewRow {
  return {
    row_number: number,
    status: 'ok',
    company: null,
    prospect: {
      civility: 'mr',
      first_name: `Prénom${String(number)}`,
      last_name: 'Essai',
      exact_job_title: null,
      role_suggestions: [],
      activity_status_suggestion: null,
    },
    emails: [],
    phones: [],
    tracking: null,
    legacy_metadata: {},
    duplicates: [],
    blocked_by_do_not_contact: false,
    diagnostics: [],
    cells: [],
    ...fields,
  }
}

function company(name: string) {
  return {
    display_name: name,
    match_key: name.toLowerCase(),
    email_domain: null,
    project_done_with_circoe: null,
    project_type: null,
    circoe_references: null,
    client_approach: null,
    activity_categories: [],
    unmatched_categories: [],
    segment_suggestion: null,
    establishment: null,
    candidates: [],
  }
}

function diagnostic(code: string, severity: 'error' | 'warning' | 'info', message: string, value: string | null = null) {
  return { code, severity, message, row: null, column: null, field: null, value }
}

function review(rows: RowReview[], preview: PreviewRow[], extra: Partial<ImportReview> = {}): ImportReview {
  const byStatus = { ok: 0, warning: 0, error: 0 }
  const codes: Record<string, number> = {}
  for (const item of preview) {
    byStatus[item.status] += 1
    for (const found of item.diagnostics) codes[found.code] = (codes[found.code] ?? 0) + 1
  }
  return {
    preview: {
      summary: {
        file_name: 'base_synthetique.xlsx',
        file_format: 'xlsx',
        file_fingerprint: FINGERPRINT,
        encoding: null,
        delimiter: null,
        sheet: 'Base client ',
        header_row: 1,
        sheets: [
          { name: 'Base client ', status: 'imported', rows: preview.length + 1, merged_ranges: 0 },
          { name: 'actualité', status: 'skipped', rows: 3, merged_ranges: 0 },
        ],
        columns: [
          { column: 'A', index: 0, header: 'Référent', field: 'referent', matched_by: 'header' },
          { column: 'C', index: 2, header: 'Entreprise', field: 'company_name', matched_by: 'header' },
          { column: 'L', index: 11, header: 'Nom', field: 'last_name', matched_by: 'header' },
          { column: 'M', index: 12, header: 'Prénom', field: 'first_name', matched_by: 'header' },
          { column: 'X', index: 23, header: null, field: null, matched_by: 'none' },
        ],
        rows_total: preview.length,
        rows_empty: 0,
        rows_by_status: byStatus,
        counts_by_severity: { error: 0, warning: 0, info: 0 },
        counts_by_code: { ...codes, 'sheet.skipped': 1 },
        duplicate_email_groups: 0,
        notices: [
          diagnostic(
            'sheet.skipped',
            'info',
            'Feuille « actualité » ignorée : elle ne fait pas partie du modèle d’import des prospects.',
          ),
        ],
      },
      rows: preview,
    },
    digest: DIGEST,
    roles: [],
    categories: [],
    referents: [],
    weeks: [],
    civilities: [],
    companies: [],
    prospects: [],
    rows,
    ...extra,
  }
}

function rowReview(number: number, fields: Partial<RowReview> = {}): RowReview {
  return {
    row_number: number,
    role_key: null,
    category_keys: [],
    referent_key: null,
    week_key: null,
    civility_key: null,
    company_key: null,
    inactive_suggested: false,
    default_resolution: { action: 'create' },
    ...fields,
  }
}

// Five rows: a clean one, an unknown role shared by two rows (grouped), a row without any name (error), a row
// matching an existing prospect by e-mail (attached by default) and one matching a « Ne pas contacter » prospect.
export function sampleReview(): ImportReview {
  const unknownRole = diagnostic(
    'role.unmatched',
    'warning',
    'Aucun rôle existant ne correspond à la fonction : à associer, créer ou laisser vide.',
  )
  const preview = [
    row(2, { company: company('Transports Témoin'), emails: [{ address: 'jean.essai@example.com', is_primary: true }] }),
    row(3, {
      status: 'warning',
      company: company('Transports Témoin'),
      prospect: { ...row(3).prospect, exact_job_title: 'Directeur fictif' },
      diagnostics: [unknownRole],
    }),
    row(4, {
      status: 'error',
      prospect: { ...row(4).prospect, first_name: null, last_name: null },
      company: company('Messagerie Fictive'),
      diagnostics: [diagnostic('prospect.missing_name', 'error', 'Ni nom ni prénom : le prospect ne peut pas être créé.')],
      cells: [{ column: 'C', value: 'Messagerie Fictive', mapped: true, preserved: false, copied_from_merge: false, corrected: false }],
    }),
    row(5, {
      status: 'warning',
      prospect: { ...row(5).prospect, first_name: 'Luc', last_name: 'Exemple', exact_job_title: 'DIRECTEUR FICTIF' },
      emails: [{ address: 'luc.exemple@example.com', is_primary: true }],
      diagnostics: [
        unknownRole,
        diagnostic('duplicate.email_existing', 'warning', 'Adresse e-mail déjà connue dans la base.'),
      ],
      duplicates: [
        { kind: 'existing_prospect', row: null, prospect_id: LUC_ID, reasons: ['same_email'], confidence: 1, contactability: 'contactable' },
      ],
    }),
    row(6, {
      status: 'error',
      prospect: { ...row(6).prospect, first_name: 'Bruno', last_name: 'Bloqué' },
      blocked_by_do_not_contact: true,
      diagnostics: [
        diagnostic(
          'contactability.do_not_contact',
          'error',
          'Correspond à un prospect « Ne pas contacter » : l’import ne peut ni le recréer ni le réactiver.',
        ),
      ],
      duplicates: [
        { kind: 'existing_prospect', row: null, prospect_id: BLOCKED_ID, reasons: ['same_email'], confidence: 1, contactability: 'do_not_contact' },
      ],
    }),
  ]
  const rows = [
    rowReview(2, { company_key: 'transports temoin', week_key: '37' }),
    rowReview(3, { company_key: 'transports temoin', role_key: 'directeur fictif' }),
    rowReview(4, { company_key: 'messagerie fictive' }),
    rowReview(5, { role_key: 'directeur fictif', default_resolution: { action: 'attach', prospect_id: LUC_ID } }),
    rowReview(6, { default_resolution: { action: 'exclude' } }),
  ]
  return review(rows, preview, {
    roles: [
      {
        key: 'directeur fictif',
        text: 'Directeur fictif',
        rows: [3, 5],
        status: 'unmatched',
        suggestions: [],
        default: { action: 'none' },
      },
    ],
    companies: [
      { key: 'transports temoin', display_name: 'Transports Témoin', variants: ['Transports Témoin'], rows: [2, 3], candidates: [], default: { action: 'create' } },
      { key: 'messagerie fictive', display_name: 'Messagerie Fictive', variants: ['Messagerie Fictive'], rows: [4], candidates: [], default: { action: 'create' } },
    ],
    weeks: [{ key: '37', week: 37, rows: [2] }],
    prospects: [
      { id: LUC_ID, first_name: 'Luc', last_name: 'Exemple', company_name: 'Logistique Démo SAS', emails: ['luc.exemple@example.com'], contactability: 'contactable' },
      { id: BLOCKED_ID, first_name: 'Bruno', last_name: 'Bloqué', company_name: 'Logistique Démo SAS', emails: [], contactability: 'do_not_contact' },
    ],
  })
}

export function samplePreview(previous: ImportBatch[] = []): PreviewResult {
  return { review: sampleReview(), previous_imports: previous }
}

export function batch(fields: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: '00000000-0000-7000-8000-00000000b001',
    filename: 'base_synthetique.xlsx',
    sheet_names: ['Base client '],
    status: 'committed',
    created_at: '2026-09-01T09:30:00+00:00',
    committed_at: '2026-09-01T09:31:00+00:00',
    actor_type: 'human',
    actor_display: 'Pilote Test',
    rows_total: 5,
    rows_imported: 3,
    rows_skipped: 2,
    legal_basis_or_collection_context: 'Fichier historique Circoe — prospection B2B',
    source_reference: null,
    ...fields,
  }
}

export function commitResult(): CommitResult {
  return {
    batch: batch(),
    counts: { prospects_created: 2, prospects_attached: 1, companies_created: 1, emails_added: 2, phones_added: 0 },
  }
}
