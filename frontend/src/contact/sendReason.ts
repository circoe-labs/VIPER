import { sendErrorLabel } from './mailModel'

// Why a scheduled mail did not leave, in a few words for the lists (the editor keeps the long explanation,
// `dispatchLine`). Codes: backend contact_dispatch / contact_schedule_trace / warehouse_dispatch.
const REASONS: Record<string, string> = {
  dispatch_overdue: 'heure dépassée : serveur arrêté ou Toolbox déconnectée',
  dispatch_held: 'programmation retirée par l’exploitation du serveur',
  send_draft_not_found: 'brouillon introuvable dans Infomaniak (supprimé, ou envoyé à la main)',
  send_not_confirmed: 'envoi non confirmé : peut-être parti',
  send_outcome_unknown: 'la Toolbox n’a pas donné de réponse sûre : peut-être parti',
  send_reconcile_inconclusive: 'envoi impossible à vérifier : peut-être parti',
  send_probably_sent: 'probablement parti',
  send_released_by_person: 'remis en Validé après vérification',
  unscheduled_by_person: 'déprogrammé à la main',
  edited: 'message modifié : à revalider et reprogrammer',
  cancelled: 'message annulé',
  not_validated: 'message non validé',
}

// The default lateness the server tolerates (only worded when the code carries no short label of its own).
const LATENESS_MINUTES = 360

export function sendReason(code: string): string {
  // A warehouse mail's failure names the stage: `create_draft:<code>` (nothing left) or `send_draft:<code>`.
  if (code.startsWith('create_draft:')) return 'brouillon Infomaniak non créé : le mail n’est pas parti'
  if (code.startsWith('send_draft:')) return 'envoi non confirmé : peut-être parti'
  return REASONS[code] ?? sendErrorLabel(code, LATENESS_MINUTES)
}
