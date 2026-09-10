import { settingsRefusal } from '../api/settings'

// French copy for Settings refusals (API `detail.code`, backend/app/api/routes/settings.py) and usage counts.

const USAGE_NOUNS: Record<string, readonly [singular: string, plural: string]> = {
  prospects: ['prospect', 'prospects'],
  companies: ['entreprise', 'entreprises'],
  contact_trackings: ['suivi de contact', 'suivis de contact'],
}

export function usageText(count: number, noun: string): string {
  const [singular, plural] = USAGE_NOUNS[noun] ?? [noun, noun]
  return `${String(count)} ${count > 1 ? plural : singular}`
}

function usagePhrase(usage: Record<string, number>): string {
  return Object.entries(usage)
    .map(([noun, count]) => usageText(count, noun))
    .join(' et ')
}

const INVALID_FIELDS: Record<string, string> = {
  label: 'Saisissez un libellé (255 caractères au plus).',
  first_name: 'Saisissez le prénom (100 caractères au plus).',
  last_name: 'Saisissez le nom (100 caractères au plus).',
  email: 'Adresse e-mail invalide.',
}

// `subject` names the value the action was about (e.g. the label of the value being deleted).
export function settingsErrorMessage(error: unknown, subject?: string): string {
  const refusal = settingsRefusal(error)
  const existing = refusal?.existing
  switch (refusal?.code) {
    case 'duplicate':
      if (!existing) return 'Cette valeur existe déjà.'
      if (refusal.field === 'email') return `Cette adresse e-mail est déjà celle de « ${existing.label} ».`
      return existing.active
        ? `« ${existing.label} » existe déjà.`
        : `« ${existing.label} » existe déjà mais est désactivé : réactivez-le plutôt que de créer un doublon.`
    case 'in_use': {
      const usage = usagePhrase(refusal.usage ?? {})
      return `Suppression impossible : ${subject ? `« ${subject} »` : 'cette valeur'} est utilisé par ${usage}. Désactivez-le pour le retirer des listes de choix ; les fiches existantes le conservent.`
    }
    case 'invalid':
      return INVALID_FIELDS[refusal.field ?? ''] ?? 'Valeur invalide.'
    case 'not_found':
      return 'Cette valeur n’existe plus : la liste a été actualisée.'
    default:
      return 'L’opération a échoué. Vérifiez la connexion puis réessayez.'
  }
}
