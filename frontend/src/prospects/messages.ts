import { settingsRefusal } from '../api/settings'

// French copy for Prospects API refusals (backend/app/api/routes/prospects.py, codes of app/api/errors.py).

export interface ProspectRefusal {
  // Field path in the draft (`emails.2.address`), or null for a form-level message.
  field: string | null
  message: string
  // The prospect changed since it was opened (409 `conflict`): the editor offers to reload it.
  conflict?: boolean
}

// Draft index of each alias the payload carried (blank new lines are left out of it).
export interface AliasIndexes {
  emails: number[]
  phones: number[]
}

const ALIAS_INVALID: Record<string, string> = {
  'address.blank': 'Saisissez l’adresse ou retirez la ligne.',
  'address.format': 'Adresse e-mail invalide (ex. prenom.nom@exemple.fr).',
  'address.repeated': 'Cette adresse est déjà saisie.',
  'number.blank': 'Saisissez le numéro ou retirez la ligne.',
  'number.format': 'Numéro invalide : 10 chiffres pour la France (06 12 34 56 78), ou +indicatif.',
  'number.repeated': 'Ce numéro est déjà saisi.',
  'type.blank': 'Choisissez le type de téléphone.',
  'is_primary.multiple': 'Une seule ligne peut être principale.',
  'is_primary.inactive': 'Une ligne inactive ne peut pas être principale.',
  'verification_status.verification_action': 'Utilisez « Vérifié » pour confirmer cette coordonnée.',
  'id.unknown': 'Cette ligne n’existe plus : rechargez la fiche.',
  'source_reference.length': 'Source trop longue (1 000 caractères au plus).',
}

const FIELD_INVALID: Record<string, string> = {
  'first_name.length': '100 caractères au plus.',
  'last_name.length': '100 caractères au plus.',
  'last_name.blank': 'Saisissez au moins un prénom ou un nom.',
  'company_id.blank': 'Choisissez l’entreprise, ou créez-la depuis ce champ.',
  'company_id.unknown': 'Cette entreprise n’existe plus : choisissez-en une autre.',
  'role_id.unknown': 'Ce rôle n’existe plus : choisissez-en un autre.',
  'role_label.length': 'Libellé de rôle trop long (255 caractères au plus).',
  'exact_job_title.length': '255 caractères au plus.',
  'employment_verification.day.future': 'La date de vérification ne peut pas être dans le futur.',
  'employment_verification.day.blank': 'Choisissez la date de vérification.',
  'tracking.referent_id.unknown': 'Ce référent n’existe plus : choisissez-en un autre.',
  'tracking.appointment_time.without_day': 'Indiquez aussi le jour du rendez-vous.',
  'provenance.legal_basis_or_collection_context.blank': 'Indiquez le contexte de collecte (ou la base légale).',
  'provenance.legal_basis_or_collection_context.length': 'Texte trop long (2 000 caractères au plus).',
  'provenance.source_reference.length': 'Texte trop long (2 000 caractères au plus).',
  'reason.blank': 'Indiquez le motif.',
  'reason.length': 'Motif trop long (2 000 caractères au plus).',
}

// `emails.1.address` of the payload → `emails.<draft index>.address`; a new role's label shows on the role picker.
function draftPath(field: string, indexes: AliasIndexes): string {
  if (field === 'role_label') return 'role_id'
  const [kind, index, ...rest] = field.split('.')
  if ((kind !== 'emails' && kind !== 'phones') || index === undefined || rest.length === 0) return field
  const draftIndex = indexes[kind][Number(index)] ?? Number(index)
  return [kind, String(draftIndex), ...rest].join('.')
}

function invalidMessage(field: string, reason: string | undefined): string {
  const parts = field.split('.')
  if ((parts[0] === 'emails' || parts[0] === 'phones') && parts.length === 1) {
    return 'Deux lignes échangent leurs valeurs : enregistrez en deux fois.'
  }
  if (parts[0] === 'emails' || parts[0] === 'phones') {
    return ALIAS_INVALID[`${parts.slice(2).join('.')}.${reason ?? ''}`] ?? 'Valeur invalide.'
  }
  return FIELD_INVALID[`${field}.${reason ?? ''}`] ?? 'Valeur invalide.'
}

// A failed save, opposition change or deletion, as a message placed on its field when the API names one.
export function prospectRefusal(error: unknown, indexes: AliasIndexes = { emails: [], phones: [] }): ProspectRefusal {
  const refusal = settingsRefusal(error)
  switch (refusal?.code) {
    case 'invalid': {
      const field = refusal.field ?? ''
      return { field: draftPath(field, indexes), message: invalidMessage(field, refusal.reason) }
    }
    case 'duplicate': {
      const existing = refusal.existing
      const message = existing
        ? existing.active
          ? `Le rôle « ${existing.label} » existe déjà : choisissez-le dans la liste.`
          : `Le rôle « ${existing.label} » existe mais est désactivé : réactivez-le dans Paramètres.`
        : 'Ce rôle existe déjà : choisissez-le dans la liste.'
      return { field: 'role_id', message }
    }
    case 'conflict':
      return {
        field: null,
        conflict: true,
        message: 'Ce prospect a été modifié ailleurs depuis son ouverture. Rechargez la fiche pour voir la version actuelle.',
      }
    case 'do_not_contact':
      return {
        field: null,
        message: 'Suppression impossible : ce prospect est en opposition. Levez d’abord l’opposition (avec son motif).',
      }
    case 'not_found':
      return { field: null, message: 'Ce prospect n’existe plus : il a peut-être été supprimé entre-temps.' }
    default:
      return { field: null, message: 'L’enregistrement a échoué. Vérifiez la connexion puis réessayez.' }
  }
}
