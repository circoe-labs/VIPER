import { ApiError } from '../api/client'
import type {
  DecisionError,
  ImportRefusal,
  MatchReason,
  MatchStatus,
  ProspectResolution,
  ReferentStatus,
} from '../api/imports'
import type { RowIssue } from './importPlan'

// French copy of the Excel import page (Task 09). Diagnostic messages come from the engine catalogue already in
// French (backend/app/services/imports/diagnostics.py); here are the short labels and the page's own messages.

// Short labels of the row-level diagnostic codes, for the filter chips.
const CODE_LABELS: Record<string, string> = {
  'prospect.missing_name': 'Ni nom ni prénom',
  'prospect.partial_name': 'Nom ou prénom manquant',
  'contactability.do_not_contact': 'Ne pas contacter',
  'contactability.possible_do_not_contact': 'Homonyme « Ne pas contacter »',
  'company.missing': 'Entreprise manquante',
  'company.existing_match': 'Entreprise déjà connue',
  'company.likely_match': 'Entreprise proche',
  'company.variant_in_file': 'Entreprise écrite autrement',
  'company.field_conflict': 'Valeurs d’entreprise différentes',
  'civility.invalid': 'Civilité non reconnue',
  'role.suggested': 'Rôle proposé',
  'role.unmatched': 'Rôle non reconnu',
  'role.inactive_match': 'Rôle désactivé',
  'category.suggested': 'Catégorie proposée',
  'category.unmatched': 'Catégorie inconnue',
  'category.invalid': 'Catégorie invalide',
  'category.inactive_match': 'Catégorie désactivée',
  'category.segment_suggested': 'Segment proposé',
  'referent.marker': 'Marqueur dans Référent',
  'referent.email_like': 'E-mail dans Référent',
  'referent.week_marker': 'Semaine dans Référent',
  'referent.note': 'Note dans Référent',
  'referent.unknown': 'Référent inconnu',
  'referent.partial_match': 'Référent partiel',
  'referent.ambiguous': 'Référent ambigu',
  'referent.inactive': 'Référent désactivé',
  'planned_contact.week_without_year': 'Semaine sans année',
  'planned_contact.not_a_week': 'Pas une semaine',
  'planned_contact.invalid_week': 'Semaine impossible',
  'activity.inactive_suggested': 'Inactif suggéré',
  'tracking.stage_conflict': 'Étapes contradictoires',
  'tracking.stage_unrecognized': 'Étape non reconnue',
  'email.invalid': 'E-mail invalide',
  'email.multiple_in_cell': 'Plusieurs e-mails',
  'phone.invalid': 'Téléphone invalide',
  'phone.leading_zero_restored': '0 initial restauré',
  'phone.unrecognized_format': 'Téléphone non français',
  'phone.multiple_in_cell': 'Plusieurs téléphones',
  'address.unstructured': 'Adresse libre',
  'address.without_company': 'Adresse sans entreprise',
  'duplicate.email_in_file': 'E-mail en double',
  'duplicate.person_in_file': 'Personne en double',
  'duplicate.email_existing': 'E-mail déjà connu',
  'duplicate.person_existing': 'Personne déjà connue',
  'duplicate.person_name_existing': 'Homonyme dans la base',
  'value.too_long': 'Valeur trop longue',
  'value.zero_placeholder': '« 0 » ignoré',
  'cell.merged_value_copied': 'Cellule fusionnée',
}

export function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code
}

export const STATUS_LABELS = { ok: 'Sans remarque', warning: 'À vérifier', error: 'En erreur' } as const

export const REASON_LABELS: Record<MatchReason, string> = {
  same_email: 'même adresse e-mail',
  same_person: 'mêmes nom, prénom et entreprise',
  same_name: 'mêmes nom et prénom',
  same_company_name: 'même nom d’entreprise',
  similar_company_name: 'nom d’entreprise proche',
  same_email_domain: 'même domaine e-mail',
}

export function reasonsText(reasons: MatchReason[]): string {
  return reasons.map((reason) => REASON_LABELS[reason]).join(', ')
}

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  exact: 'Reconnu',
  suggested: 'À confirmer',
  inactive: 'Valeur désactivée',
  segment: 'Segment commercial',
  unmatched: 'Inconnu',
}

export const REFERENT_STATUS_LABELS: Record<ReferentStatus, string> = {
  exact: 'Reconnu',
  partial: 'Reconnu partiellement',
  ambiguous: 'Plusieurs référents possibles',
  inactive: 'Référent désactivé',
  unknown: 'Référent inconnu',
  marker: 'Marqueur historique',
  email_like: 'Adresse e-mail',
  week_marker: 'Semaine de contact',
  note: 'Note libre',
}

export function resolutionLabel(resolution: ProspectResolution): string {
  switch (resolution.action) {
    case 'create':
      return 'Nouveau prospect'
    case 'attach':
      return 'Complète un prospect existant'
    case 'attach_row':
      return `Fusionnée avec la ligne ${String(resolution.row)}`
    case 'exclude':
      return 'Exclue'
  }
}

export const ISSUE_LABELS: Record<RowIssue, string> = {
  missing_name: 'Ni nom ni prénom : corrigez la ligne, rattachez-la à un prospect ou excluez-la.',
  blocked:
    'Correspond à un prospect « Ne pas contacter » : excluez la ligne ou rattachez-la à ce prospect (il reste bloqué).',
  attached_to_excluded: 'Fusionnée avec une ligne exclue : choisissez une autre résolution.',
}

export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count > 1 ? many : one}`
}

export function rowsText(count: number): string {
  return plural(count, 'ligne', 'lignes')
}

// What each import field becomes (column correspondence of the sheet step, correction form).
const FIELD_LABELS: Record<string, string> = {
  referent: 'Référent',
  planned_contact: 'À contacter (semaine ou date)',
  company_name: 'Entreprise',
  stage_appointment: 'RDV obtenu',
  stage_quote_sent: 'Devis envoyé',
  stage_quote_follow_up: 'Suivi du devis',
  stage_follow_up_1: 'Relance 1',
  stage_follow_up_2: 'Relance 2',
  contact_mode: 'Mode de contact (conservé tel quel)',
  category: 'Catégories d’activité',
  civility: 'Civilité',
  last_name: 'Nom',
  first_name: 'Prénom',
  job_title: 'Fonction (rôle)',
  email: 'E-mail',
  phone: 'Téléphone',
  mobile: 'Mobile',
  address: 'Adresse (établissement)',
  project_done_with_circoe: 'Projet déjà réalisé',
  project_type: 'Type de projet',
  circoe_references: 'Références Circoe',
  client_approach: 'Approche client',
  legacy_to_contact_flag: 'Second « A contacter » (conservé tel quel)',
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

const DECISION_ERRORS: Record<string, string> = {
  unknown_row: 'une ligne n’existe plus dans le fichier',
  unknown_key: 'une valeur associée n’existe plus dans l’analyse',
  unknown_value: 'une valeur choisie n’existe plus (supprimée dans Paramètres ?)',
  invalid_week_year: 'la semaine 53 n’existe pas pour l’année choisie',
  inactive_not_suggested: 'le statut « Inactif » ne peut être confirmé que lorsqu’il est suggéré',
  missing_name: 'ligne sans nom ni prénom',
  blocked_by_do_not_contact: 'ligne correspondant à un prospect « Ne pas contacter »',
  not_a_candidate: 'le prospect choisi n’est pas un doublon proposé',
  attached_to_excluded: 'fusion avec une ligne exclue',
  attach_cycle: 'fusions en boucle',
  nothing_to_import: 'aucune ligne à importer',
}

export function decisionErrorText(error: DecisionError): string {
  const text = DECISION_ERRORS[error.code] ?? error.code
  return error.row === null ? text : `Ligne ${String(error.row)} : ${text}`
}

export function refusalOf(error: unknown): ImportRefusal | null {
  if (!(error instanceof ApiError) || typeof error.detail !== 'object' || error.detail === null) return null
  return 'code' in error.detail ? (error.detail as ImportRefusal) : null
}

// The message shown when an analysis or a commit fails.
export function importErrorMessage(error: unknown): string {
  const refusal = refusalOf(error)
  if (error instanceof ApiError && error.status === 401) return 'Votre session a expiré : reconnectez-vous.'
  switch (refusal?.code) {
    case 'file_rejected':
      return refusal.diagnostic.message
    case 'file_changed':
      return 'Le fichier envoyé n’est pas celui qui a été analysé : relancez l’analyse.'
    case 'preview_outdated':
      return 'Les données de la base ont changé depuis l’analyse (prospects, entreprises ou paramètres). Relancez l’analyse : vos choix sont conservés.'
    case 'reimport_not_acknowledged':
      return 'Ce fichier a déjà été importé : confirmez que vous voulez l’importer à nouveau.'
    case 'invalid_decisions':
      return `Import impossible : ${refusal.errors.map(decisionErrorText).join(' ; ')}.`
    case 'duplicate':
      return refusal.existing
        ? `« ${refusal.existing.label} » existe déjà dans Paramètres : associez-le au lieu de le créer.`
        : 'Une valeur à créer existe déjà dans Paramètres : associez-la au lieu de la créer.'
    case 'commit_failed':
      return refusal.row === null
        ? 'L’import a échoué : aucune donnée n’a été enregistrée. La tentative figure dans l’historique.'
        : `L’import a échoué sur la ligne ${String(refusal.row)} : aucune donnée n’a été enregistrée. La tentative figure dans l’historique.`
    case 'length_required':
    case 'invalid_request':
      return 'Requête d’import invalide : rechargez la page et recommencez.'
    default:
      return 'Service indisponible : réessayez dans un instant.'
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

export function formatDateTime(iso: string): string {
  return DATE_FORMAT.format(new Date(iso))
}

export function formatDay(date: Date): string {
  return DAY_FORMAT.format(date)
}
