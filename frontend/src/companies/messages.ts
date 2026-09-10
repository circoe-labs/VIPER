import { settingsRefusal } from '../api/settings'

// French copy for Company API refusals (backend/app/api/routes/companies.py, codes of app/api/errors.py). The API
// answers with the same `{ code, field, reason, existing, usage }` shape as the Settings API.

const FIELD_NAMES: Record<string, string> = {
  display_name: 'le nom',
  legal_name: 'la raison sociale',
  size_label: 'la taille',
  name: 'le nom de l’établissement',
  kind: 'le type',
  address_line1: 'l’adresse',
  address_line2: 'le complément d’adresse',
  postal_code: 'le code postal',
  city: 'la ville',
  country: 'le pays',
}

// `establishments.1.siret` → `siret`.
function leaf(field: string): string {
  return field.split('.').at(-1) ?? field
}

function invalidMessage(field: string, reason: string | undefined): string {
  const name = leaf(field)
  if (name === 'siren' || name === 'siret') {
    const label = name.toUpperCase()
    return reason === 'checksum'
      ? `Ce ${label} n’est pas valide : un chiffre est sans doute erroné (clé de contrôle).`
      : reason === 'repeated'
        ? 'Ce SIRET est déjà saisi pour un autre établissement.'
        : `Le ${label} comporte ${name === 'siren' ? '9' : '14'} chiffres.`
  }
  if (name === 'email_domain') {
    return reason === 'webmail'
      ? 'Ce domaine est celui d’une messagerie grand public : il ne désigne pas l’entreprise.'
      : 'Domaine invalide : saisissez par exemple exemple.fr.'
  }
  if (name === 'website_url') return 'Adresse de site invalide (ex. www.exemple.fr).'
  if (name === 'display_name' && reason === 'blank') return 'Saisissez le nom de l’entreprise.'
  if (name === 'commercial_segment_id') return 'Ce segment n’existe plus : choisissez-en un autre.'
  if (name === 'activity_category_ids') return 'Une catégorie choisie n’existe plus : retirez-la.'
  if (name === 'is_primary') return 'Un seul établissement peut être principal.'
  if (name === 'id') return 'Cet établissement n’existe plus : rechargez la fiche.'
  if (reason === 'length') return `Texte trop long pour ${FIELD_NAMES[name] ?? 'ce champ'}.`
  return 'Valeur invalide.'
}

export interface CompanyRefusal {
  // Field path the message belongs to (`siren`, `establishments.1.siret`), or null for a form-level message.
  field: string | null
  message: string
}

// A failed save or delete, as a message placed on its field when the API names one.
export function companyRefusal(error: unknown): CompanyRefusal {
  const refusal = settingsRefusal(error)
  const field = refusal?.field ?? null
  switch (refusal?.code) {
    case 'duplicate': {
      const label = leaf(field ?? '') === 'siren' ? 'Ce SIREN' : 'Ce SIRET'
      const owner = refusal.existing ? ` de « ${refusal.existing.label} »` : ' d’une autre entreprise'
      return { field, message: `${label} est déjà celui${owner}.` }
    }
    case 'invalid':
      return { field, message: invalidMessage(field ?? '', refusal.reason) }
    case 'in_use': {
      const count = refusal.usage?.prospects ?? 0
      return {
        field: null,
        message: `Suppression impossible : l’entreprise est rattachée à ${String(count)} prospect${count > 1 ? 's' : ''}.`,
      }
    }
    case 'not_found':
      return { field: null, message: 'Cette entreprise n’existe plus : elle a peut-être été supprimée entre-temps.' }
    default:
      return { field: null, message: 'L’enregistrement a échoué. Vérifiez la connexion puis réessayez.' }
  }
}
