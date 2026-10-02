import { ApiError } from '../api/client'
import type { TrackingStatus } from '../api/prospection'
import type { CohortRef, Prospect } from '../api/prospects'
import type { AlertDetail, AlertSource, AlertType, Place, SendSource, SequenceEndReason } from '../api/sequences'
import type { Cohort } from '../api/settings'
import { formatDay, TRACKING_LABELS } from '../prospection/labels'

// Pure rules and French copy of « Séquence de contact » (sequences rework D1-D12): what the sheet says about the cohort,
// the level and the next send, which human action is offered, and the refusals of their operations. The server stays
// the judge: these only explain before acting.

// --- validation, level, next send ------------------------------------------------------------------------------------

// « S39 — premier envoi le 28 sept. 2026 », « S0 — validé hors campagne », « Non validé ».
export function validationText(cohort: CohortRef | null): string {
  if (cohort === null) return 'Non validé'
  if (cohort.out_of_campaign) return `${cohort.code} — validé hors campagne`
  return cohort.starts_on ? `${cohort.code} — premier envoi le ${formatDay(cohort.starts_on)}` : cohort.code
}

// The option of a cohort in a picker: « S39 — 28 sept. 2026 », « S0 — validé hors campagne ».
export function cohortChoiceLabel(cohort: Pick<Cohort, 'code' | 'starts_on' | 'out_of_campaign'>): string {
  if (cohort.out_of_campaign) return `${cohort.code} — validé hors campagne`
  return cohort.starts_on ? `${cohort.code} — ${formatDay(cohort.starts_on)}` : cohort.code
}

// Why nothing is due, in one sentence; null when something is due.
export function pauseText(place: Place, state: TrackingStatus): string | null {
  switch (place.pause_reason) {
    case null:
      return null
    case 'no_cohort':
      return 'Aucune cohorte : le prospect n’est pas validé, aucun envoi n’est prévu.'
    case 'out_of_campaign':
      return 'S0 : validé mais hors campagne, aucun envoi n’est prévu.'
    case 'state':
      return `État « ${TRACKING_LABELS[state]} » : la séquence est hors des actions automatiques.`
    case 'do_not_contact':
      return 'Opposition « Ne pas contacter » : aucun envoi.'
    case 'sequence_closed':
      return 'Relance terminée (séquence close) : plus de relance automatique, le prospect reste contactable.'
    case 'finished':
      return `Relance terminée (R${String(place.max_follow_ups)} envoyée) : plus de relance automatique, le prospect reste contactable.`
    case 'email_error':
      return 'Erreur sur le mail ouverte : aucun envoi n’est dû tant qu’elle n’est pas résolue.'
  }
}

// The step's rank from its code (`contact` → 0, `r3` → 3); null for anything else.
export function rankOf(step: string | null): number | null {
  if (step === 'contact') return 0
  const rank = /^r([1-9]\d?)$/.exec(step ?? '')?.[1]
  return rank ? Number(rank) : null
}

// The next step's due date has come (business day, compared as `YYYY-MM-DD`): the `due` segment's « Échu ».
export function isDue(place: Place, today: string): boolean {
  return place.next_due_on !== null && place.next_due_on <= today
}

// --- the human actions offered ---------------------------------------------------------------------------------------

export interface SequenceActions {
  // The rank « Marquer comme envoyé » declares; null when no send can be declared.
  markRank: number | null
  // Null when the cohort may change, else why not.
  cohortBlocked: string | null
  disqualify: boolean
  resume: boolean
  emailError: boolean
}

const CLOSING_STATES: readonly TrackingStatus[] = ['response_received', 'appointment_obtained', 'ignored', 'disqualified']

export function sequenceActions(place: Place, prospect: Prospect): SequenceActions {
  const state = prospect.tracking?.status ?? 'neutral'
  const opposed = prospect.contactability_status === 'do_not_contact'
  const sendable =
    place.sequence_open &&
    place.sequence_id !== null &&
    place.cohort?.out_of_campaign === false &&
    !opposed &&
    !CLOSING_STATES.includes(state)
  return {
    markRank: sendable ? rankOf(place.next_step) : null,
    cohortBlocked:
      state === 'ignored'
        ? '« Ignoré » est définitif : ce prospect ne reprend jamais de séquence.'
        : opposed
          ? 'Opposition « Ne pas contacter » : levez-la d’abord (avec son motif) pour changer la cohorte.'
          : null,
    disqualify: state !== 'ignored' && state !== 'disqualified',
    resume: state === 'disqualified',
    emailError: !place.email_error,
  }
}

// --- history ---------------------------------------------------------------------------------------------------------

export const END_REASON_LABELS: Record<SequenceEndReason, string> = {
  cohort_changed: 'Close : changement de cohorte',
  cohort_removed: 'Close : cohorte retirée',
  completed: 'Close : relances terminées',
}

export const SEND_SOURCE_LABELS: Record<SendSource, string> = {
  manual: 'déclaré à la main',
  import: 'import',
  migration: 'reprise de l’ancien suivi',
  worker: 'envoi automatique',
}

// --- quality alerts --------------------------------------------------------------------------------------------------

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  email_error: 'Erreur sur le mail',
  function_to_check: 'Fonction à vérifier',
  data_inconsistent: 'Donnée incohérente',
  company_to_check: 'Entreprise à vérifier',
  import_conflict: 'Conflit d’import',
}

// The AI only proposes (handoff §14): its alerts are said as proposals.
export function alertSourceLabel(source: AlertSource, raisedBy: string): string {
  if (source === 'ai') return 'Proposition de l’IA'
  if (source === 'import') return `Import${raisedBy ? ` · ${raisedBy}` : ''}`
  return `Signalée par ${raisedBy}`
}

// Labels of the fields an import conflict names (backend import_precedence.FIELD_LABELS).
const FIELD_LABELS: Record<string, string> = {
  civility: 'Civilité',
  first_name: 'Prénom',
  last_name: 'Nom',
  exact_job_title: 'Fonction',
  activity_status: 'Statut d’activité',
  company_id: 'Entreprise',
  emails: 'E-mail',
  phones: 'Téléphone',
  referent_id: 'Référent',
  contact_state: 'État commercial',
  cohort: 'Cohorte',
  commercial_segment_id: 'Segment commercial',
  activity_category_ids: 'Catégories d’activité',
  address: 'Adresse',
}

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(vide)'
  if (Array.isArray(value)) return value.map(shown).join(', ') || '(vide)'
  if (typeof value === 'object') return JSON.stringify(value)
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export interface ConflictLine {
  label: string
  value: string
}

// What an import conflict compared (field, VIPER's value, the file's) and where the file said it; empty for an alert
// without such detail.
export function conflictLines(detail: AlertDetail): ConflictLine[] {
  const lines: ConflictLine[] = []
  if (typeof detail.field === 'string') lines.push({ label: 'Champ', value: FIELD_LABELS[detail.field] ?? detail.field })
  if ('viper_value' in detail) lines.push({ label: 'Valeur VIPER', value: shown(detail.viper_value) })
  if ('file_value' in detail) lines.push({ label: 'Valeur du fichier', value: shown(detail.file_value) })
  const where = [
    typeof detail.file === 'string' && `fichier « ${detail.file} »`,
    typeof detail.sheet === 'string' && `feuille « ${detail.sheet} »`,
    typeof detail.row === 'number' && `ligne ${String(detail.row)}`,
  ].filter(Boolean)
  if (where.length > 0) lines.push({ label: 'Import', value: where.join(', ') })
  return lines
}

// --- refusals --------------------------------------------------------------------------------------------------------

export interface SequenceRefusal {
  message: string
  // The screen is out of date (another tab, a cohort change): read the prospect again.
  stale: boolean
}

const MESSAGES: Record<string, string> = {
  sequence_changed: 'La cohorte a changé entre-temps : la séquence affichée n’est plus celle en cours. La fiche est rechargée.',
  rank_not_next: 'L’envoi suivant a changé entre-temps (un autre envoi a été déclaré). La fiche est rechargée.',
  no_open_sequence: 'Aucune séquence ouverte : mettez d’abord le prospect dans une cohorte.',
  prospect_sequence_closed: 'L’état commercial actuel a sorti la séquence des actions : aucun envoi ne peut être déclaré.',
  out_of_campaign: 'S0 : prospect hors campagne, aucun envoi ne peut être déclaré.',
  prospect_do_not_contact:
    'Ce prospect est en opposition (« Ne pas contacter ») : levez d’abord l’opposition (avec son motif).',
  dispatch_in_progress: 'Ce message est en cours d’envoi automatique : il ne peut pas être déclaré à la main.',
  ignored_is_terminal: 'Ce prospect est « Ignoré » : c’est définitif, il ne reprend jamais de séquence.',
  alert_exists: 'Une alerte de ce type est déjà ouverte pour ce prospect.',
  alert_resolved: 'Cette alerte a déjà été résolue.',
  conflict: 'Ce prospect a été modifié ailleurs entre-temps. La fiche est rechargée : vérifiez puis réessayez.',
  not_found: 'Cet élément n’existe plus (supprimé entre-temps). La fiche est rechargée.',
  human_actor_required: 'Seule une personne connectée peut faire cette action (pas un agent).',
}

const INVALID: Record<string, string> = {
  'sent_at.in_future': 'La date d’envoi ne peut pas être dans le futur.',
  'sent_at.before_previous_send': 'La date d’envoi ne peut pas précéder l’envoi précédent de la séquence.',
  'sent_at.time_zone': 'Date d’envoi invalide.',
}

const STALE = new Set(['sequence_changed', 'rank_not_next', 'no_open_sequence', 'conflict', 'not_found'])

export function sequenceRefusal(error: unknown): SequenceRefusal {
  const detail = error instanceof ApiError ? error.detail : null
  const code = typeof detail === 'object' && detail !== null && 'code' in detail ? String(detail.code) : null
  if (code === 'invalid' && typeof detail === 'object' && detail !== null) {
    const key = `${'field' in detail ? String(detail.field) : ''}.${'reason' in detail ? String(detail.reason) : ''}`
    return { message: INVALID[key] ?? 'Valeur refusée par le serveur.', stale: false }
  }
  if (code !== null && code in MESSAGES) return { message: MESSAGES[code] ?? '', stale: STALE.has(code) }
  return { message: 'L’opération a échoué. Vérifiez la connexion puis réessayez.', stale: false }
}

// `YYYY-MM-DDTHH:MM` of a moment in the browser's time zone (the value of a `datetime-local` field).
export function localMinute(moment: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`
}
