import { ApiError } from '../api/client'
import { toolboxErrorLabel } from '../settings/toolboxCopy'

// French copy for the mail sequence's refusals (codes of doc/features/contact.md § Refusal codes), placed on the field
// the API names when there is one.

export type MailField = 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'body'

export interface MessageRefusal {
  message: string
  fields: Partial<Record<MailField | 'schedule', string>>
  // The server's message differs from the one shown: read it again (the unsaved edits stay in the form).
  reload: boolean
  // The saved version changed under the unsaved text (revision conflict): the next save replaces it.
  conflict?: boolean
}

const INCOMPLETE: Record<string, [MailField, string]> = {
  from_email: ['from', 'Indiquez l’adresse d’expédition.'],
  to: ['to', 'Indiquez au moins un destinataire.'],
  subject: ['subject', 'Indiquez l’objet.'],
  body_text: ['body', 'Rédigez le corps du message.'],
}

const API_FIELDS: Record<string, MailField> = { from_email: 'from', to: 'to', cc: 'cc', bcc: 'bcc', subject: 'subject' }

const LIST_NAMES: Record<string, string> = { to: 'À', cc: 'Cc', bcc: 'Cci' }

// `to.1` → the « À » field, with the address's rank.
function invalidField(field: string, reason: string | undefined): MessageRefusal {
  if (field === 'scheduled_at') {
    const text =
      reason === 'too_far'
        ? 'L’envoi ne peut pas être programmé à plus d’un an.'
        : 'Choisissez un moment dans le futur (la date et l’heure sont déjà passées).'
    return { message: text, fields: { schedule: text }, reload: false }
  }
  const [name = '', index] = field.split('.')
  const target = API_FIELDS[name]
  const rank = index === undefined ? '' : ` (adresse n° ${String(Number(index) + 1)})`
  const text =
    reason === 'control_character'
      ? 'Caractère interdit (retour à la ligne ou caractère de contrôle).'
      : reason === 'too_many'
        ? `50 adresses au plus dans « ${LIST_NAMES[name] ?? name} ».`
        : `Adresse e-mail invalide${rank}.`
  return { message: 'Un champ du message est invalide : corrigez-le puis enregistrez.', fields: target ? { [target]: text } : {}, reload: false }
}

// The API's business refusal `{detail: {code, message, field?, reason?, fields?}}`; null for anything else.
interface Refusal {
  code: string
  field?: string
  reason?: string
  fields?: unknown
}

export function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError)) return null
  const { detail } = error
  return typeof detail === 'object' && detail !== null && 'code' in detail && typeof detail.code === 'string'
    ? (detail as Refusal)
    : null
}

// A failed save or action of the mail editor, in French.
export function messageRefusal(error: unknown): MessageRefusal {
  const refusal = refusalOf(error)
  const plain = (message: string, reload = false): MessageRefusal => ({ message, fields: {}, reload })
  switch (refusal?.code) {
    case 'message_incomplete': {
      const fields: MessageRefusal['fields'] = {}
      const missing = refusal.fields
      for (const name of Array.isArray(missing) ? missing : []) {
        const entry = typeof name === 'string' ? INCOMPLETE[name] : undefined
        if (entry) fields[entry[0]] = entry[1]
      }
      return { message: 'Message incomplet : complétez les champs signalés, enregistrez, puis validez.', fields, reload: false }
    }
    case 'invalid':
      return invalidField(refusal.field ?? '', refusal.reason)
    case 'revision_conflict':
    case 'message_exists':
      return {
        message:
          'La version enregistrée de ce message a changé entre-temps (autre fenêtre ou changement d’état du prospect). Votre texte est conservé : l’enregistrer remplacera la version enregistrée. « Voir la version enregistrée » abandonne votre texte.',
        fields: {},
        reload: true,
        conflict: true,
      }
    case 'message_sent_immutable':
      return plain('Ce message est déjà envoyé : il ne peut plus être modifié.', true)
    case 'message_cancelled':
      return plain('Ce message est annulé : rouvrez-le avant de le modifier.', true)
    case 'invalid_transition':
      return plain('Action impossible dans l’état actuel du message : l’affichage est actualisé.', true)
    case 'dispatch_in_progress':
      return plain('Envoi en cours : le message est verrouillé le temps de l’envoi.', true)
    case 'prospect_do_not_contact':
      return plain('Ce prospect est en opposition (« Ne pas contacter ») : aucun message ne peut être préparé.', true)
    case 'prospect_sequence_closed':
      return plain('La séquence de ce prospect est close (réponse reçue, RDV pris ou ignoré) : action impossible.', true)
    case 'message_not_found':
      return plain('Ce message n’existe plus : l’affichage est actualisé.', true)
    case 'not_found':
      return plain('Ce prospect n’existe plus : il a peut-être été supprimé entre-temps.')
    case 'human_actor_required':
      return plain('Seule une personne connectée peut préparer, valider ou programmer un message.')
    default:
      // « Réessayer » the Infomaniak draft (S6) without a usable Toolbox: the reason, in the Settings page's words.
      if (refusal?.code.startsWith('toolbox_')) {
        return plain(`Brouillon Infomaniak non créé : ${toolboxErrorLabel(refusal.code)}.`, true)
      }
      // FastAPI's own validation (a list `detail`): the schema's size limits — more than 50 addresses in a field, an
      // address over 320 characters, a body over 100 000.
      if (error instanceof ApiError && error.status === 422 && Array.isArray(error.detail)) {
        return plain(
          'Un champ dépasse la taille autorisée (50 adresses par champ, 320 caractères par adresse, 100 000 caractères pour le corps) : raccourcissez-le puis réessayez.',
        )
      }
      return plain(
        error instanceof ApiError && error.status >= 500
          ? `Le serveur a refusé l’opération (HTTP ${String(error.status)}). Réessayez ; si cela persiste, consultez les journaux de l’API.`
          : 'L’opération a échoué. Vérifiez la connexion puis réessayez.',
      )
  }
}
