// « Résumé » card of the prospect sheet: a short synthesis written from what the sheet already holds. Pure and
// display-only: it wires values together in words and never computes a score, never repeats the person's name and never
// invents a value (an unknown input is left out of the text, a missing one is named as missing).

export type SummaryEmail = 'verified' | 'unverified' | 'invalid' | 'none'

export interface SummaryInput {
  role: string | null
  company: string | null
  // Backend word of the fiche state (« Fournie »…), null while it is not known or not evaluated.
  ficheLabel: string | null
  email: SummaryEmail
  // null = not read yet / unavailable (nothing is said about it).
  proximity: { state: 'reachable' | 'unreachable' | 'empty'; pathCount: number; label: string } | null
  // Backend commercial score: `evaluated` false = « Non évalué » (the starting value is not an evaluation).
  score: { evaluated: boolean; bandLabel: string } | null
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function jobSentence(role: string | null, company: string | null): string {
  if (role && company) return `${role} chez ${company}.`
  if (role) return `${role} (entreprise non renseignée).`
  if (company) return `Rôle non renseigné chez ${company}.`
  return 'Rôle et entreprise non renseignés.'
}

const EMAIL_WORDS: Record<SummaryEmail, string> = {
  verified: 'e-mail vérifié',
  unverified: 'e-mail non vérifié',
  invalid: 'e-mail invalide',
  none: 'aucun e-mail',
}

function proximityPhrase(proximity: NonNullable<SummaryInput['proximity']>): string {
  if (proximity.state === 'empty') return 'aucune relation enregistrée'
  if (proximity.state === 'unreachable') return 'aucun membre Circoe relié'
  const paths = `${String(proximity.pathCount)} chemin${proximity.pathCount > 1 ? 's' : ''}`
  return `proximité ${lower(proximity.label)} (${paths})`
}

// Two lines at most: the job, then the state of the fiche, e-mail, proximity and score.
export function summarizeProspect(input: SummaryInput): string[] {
  const facts = [
    input.ficheLabel ? `fiche ${lower(input.ficheLabel)}` : null,
    EMAIL_WORDS[input.email],
    input.proximity ? proximityPhrase(input.proximity) : null,
  ].filter((fact): fact is string => fact !== null)
  const score = input.score ? (input.score.evaluated ? `Score prospect ${lower(input.score.bandLabel)}.` : 'Score prospect non évalué.') : null
  const second = [facts.length > 0 ? `${upper(facts.join(', '))}.` : null, score].filter(Boolean).join(' ')
  return [jobSentence(input.role, input.company), second].filter(Boolean)
}
