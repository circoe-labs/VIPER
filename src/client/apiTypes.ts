// Formes JSON des routes /api consommées par App.tsx et importCache.ts (réponses construites dans src/server/index.ts,
// colonnes SQL de src/server/schema.ts). Types de lecture côté client : aucune validation à l'exécution.
import type { ProspectionCounters } from '../shared/prospectionDashboard';

type Nullable<T = string> = T | null;

export type SearchResult = { type: 'prospect' | 'company'; id: string; label: string; detail: Nullable };

export type AuditEntry = {
  id: string; actor_type: string; actor_id: Nullable; actor_display: Nullable; entity_type: string; entity_id: string; action: string;
  changed_fields: Nullable; before_payload: Nullable; after_payload: Nullable; source_context: Nullable; created_at: string;
};
export type NextAction = { id: string; first_name: string; last_name: string; company: string; status: string; next_action_year: Nullable<number>; next_action_week: Nullable<number> };
/** `GET /api/dashboard`. */
export type HomeDashboard = ProspectionCounters & { contacted: number; responses: number; appointments: number; nextActions: NextAction[]; recent: AuditEntry[] };

export type ProspectRow = {
  id: string; company_id: string; civility: Nullable; first_name: string; last_name: string; role_id: Nullable; exact_job_title: Nullable;
  activity_status: string; employment_verified_at: Nullable; contactability_status: string; do_not_contact_at: Nullable; do_not_contact_reason: Nullable;
  created_at: string; updated_at: string;
};
/** Ligne de `GET /api/prospects`. */
export type ProspectListItem = ProspectRow & {
  company: string; role: Nullable; primary_email: Nullable; email_verification: Nullable; email_verified_at: Nullable; tracking_status: Nullable;
  planned_contact_at: Nullable; next_action_year: Nullable<number>; next_action_week: Nullable<number>; contact_year: Nullable<number>; contact_week: Nullable<number>;
  response_received_at: Nullable; appointment_at: Nullable; referent: string; tracking_status_since: Nullable;
};

export type CompanyRow = {
  id: string; display_name: string; legal_name: Nullable; siren: Nullable; website_url: Nullable; email_domain: Nullable; size_label: Nullable;
  commercial_segment_id: Nullable; project_done_with_circoe: Nullable; project_type: Nullable; circoe_references: Nullable; client_approach: Nullable;
  created_at: string; updated_at: string;
};
/** Ligne de `GET /api/companies`. */
export type CompanyListItem = CompanyRow & { prospect_count: number };
/** Ligne de `GET /api/settings/{roles,segments,categories}` (colonnes communes). */
export type LabelRow = { id: string; label: string };
export type ReferentRow = { id: string; first_name: string; last_name: string; email: Nullable; active: number; created_at: string; updated_at: string };

type ContactPointRow = {
  id: string; prospect_id: string; is_primary: number; is_active: number; verification_status: string; origin_type: string;
  last_verified_at: Nullable; source_reference: Nullable; created_at: string; updated_at: string;
};
export type EmailRow = ContactPointRow & { address: string };
export type PhoneRow = ContactPointRow & { number: string; type: string };
export type TrackingRow = {
  id: string; prospect_id: string; planned_contact_at: Nullable; next_action_year: Nullable<number>; next_action_week: Nullable<number>; status: string;
  referent_id: Nullable; response_received_at: Nullable; appointment_at: Nullable; created_at: string; updated_at: string;
};
export type TrackingHistoryRow = { id: string; contact_tracking_id: string; from_status: Nullable; to_status: string; changed_at: string; actor_type: string; actor_id: Nullable };
export type SourceRow = {
  id: string; prospect_id: string; source_type: string; source_reference: Nullable; collected_at: string;
  legal_basis_or_collection_context: Nullable; created_by_actor: Nullable; notes: Nullable;
};
/** `GET /api/prospects/:id`. */
export type ProspectDetail = {
  prospect: ProspectRow; company: CompanyRow | null; role: Nullable; emails: EmailRow[]; phones: PhoneRow[]; tracking: TrackingRow | null;
  trackingHistory: TrackingHistoryRow[]; sources: SourceRow[]; history: AuditEntry[];
};

/** Aperçu d'import (`POST /api/import/preview`, renvoyé tel quel à `/api/import/commit`) : champs lus par le client. */
export type ImportDiagnostic = { code: string; level: 'error' | 'warning' | 'info'; message: string };
export type ImportPreviewRow = {
  row: number; raw: Record<string, unknown>; excluded: boolean; diagnostics: ImportDiagnostic[];
  normalized: {
    first_name: string; last_name: string; company: string; verification_state: string;
    planned_contact_at: Nullable; contact_year: Nullable<number>; contact_week: Nullable<number>;
  } & Record<string, unknown>;
};
export type ImportPreview = { filename: string; sheets: string[]; skippedSheets: string[]; importedAt: string; rows: ImportPreviewRow[]; fingerprint: string };

/** `GET /api/database/table/:name` (lignes brutes + `PRAGMA table_info`). */
export type TableColumn = { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
export type TableGrid = { data: Record<string, unknown>[]; columns: TableColumn[]; count: number };
