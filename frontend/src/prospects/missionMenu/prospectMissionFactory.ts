import type { MissionCategory } from '../../api/missionConfig'
import type { MissionInput, MissionType } from '../../api/missions'
import { missingForRun } from '../../missions/missionKinds'
import { kindsForType } from '../../missions/useMissionForm'

// Prospect-scoped mission factory (Slice S5). Pure: turns a preset (or a free request) + the current prospect into a
// canonical `MissionInput` for `POST /missions`, so server validation stays the single authority. The prospect is a
// real `targets[]` entry (`kind: 'prospect'`), never only free text; the company rides along as a read-only
// `context_refs[]` record. Nothing runs automatically (`run_now: false`).

// « Réanalyse son score » is not a generic mission: the menu hands it to S4's reassessment command
// (POST /prospects/{id}/score/reassessment: same prospect target, REASSESS_SCORE task, proposal reviewed before the
// score moves). It therefore has no entry here, only a tile in the menu (REASSESS_TILE).
export type MissionPreset = 'complete' | 'relations' | 'other'

export interface MissionProspect {
  id: string
  firstName: string | null
  lastName: string | null
  roleLabel?: string | null
  companyId?: string | null
  companyName?: string | null
}

export interface PresetSpec {
  id: Exclude<MissionPreset, 'other'>
  // Locked French wording of the menu (README: décisions produit).
  label: string
  hint: string
  // Category looked up at runtime by its seeded `key`, then by `mission_type`.
  categoryKey: MissionType
  name: (who: string) => string
  objective: (who: string) => string
}

export const PRESETS: readonly PresetSpec[] = [
  {
    id: 'complete',
    label: 'Complète cette fiche',
    hint: 'Coordonnées, poste, entreprise',
    categoryKey: 'enrichment',
    name: (who) => `Compléter la fiche de ${who}`,
    objective: (who) =>
      `Complète la fiche de ${who} : e-mail et téléphone professionnels, intitulé exact du poste, entreprise et rattachement, en citant tes sources. Ne remplis que ce que tu peux vérifier.`,
  },
  {
    id: 'relations',
    label: 'Cherche ses relations',
    hint: 'Liens avec l’équipe Circoe',
    categoryKey: 'other',
    name: (who) => `Chercher les relations de ${who}`,
    objective: (who) =>
      `Cherche les relations de ${who} : personnes en commun, anciens collègues, écoles, événements, publications, avec l’équipe Circoe ou d’autres prospects. Pour chaque lien, donne la source et un niveau de confiance.`,
  },
]

// Locked French wording of the menu tile that starts S4's reassessment (shown second, between the two missions).
export const REASSESS_TILE = { id: 'reassess', label: 'Réanalyse son score', hint: 'Pertinence commerciale' } as const

export function prospectDisplayName(prospect: MissionProspect): string {
  return [prospect.firstName, prospect.lastName].filter(Boolean).join(' ').trim() || 'ce prospect'
}

// Identity, company and role, as the agent reads it in the consigne.
export function prospectContextLines(prospect: MissionProspect): string {
  const lines = [
    `Prospect : ${prospectDisplayName(prospect)} (id ${prospect.id})`,
    prospect.roleLabel ? `Poste : ${prospect.roleLabel}` : null,
    prospect.companyName
      ? `Entreprise : ${prospect.companyName}${prospect.companyId ? ` (id ${prospect.companyId})` : ''}`
      : null,
  ]
  return lines.filter(Boolean).join('\n')
}

export type FactoryResult = { ok: true; input: MissionInput } | { ok: false; error: string }

function pickCategory(categories: readonly MissionCategory[], type: MissionType) {
  return categories.find((item) => item.key === type) ?? categories.find((item) => item.mission_type === type)
}

// `request` is the free text of « Autre » (required there, ignored by the other presets).
export function buildProspectMission(
  preset: MissionPreset,
  prospect: MissionProspect,
  categories: readonly MissionCategory[],
  request = '',
): FactoryResult {
  const who = prospectDisplayName(prospect)
  const spec = PRESETS.find((item) => item.id === preset)
  const text = request.trim()
  if (!spec && text === '') return { ok: false, error: 'Décrivez la mission à confier, à l’écrit ou à la voix.' }
  const category = pickCategory(categories, spec?.categoryKey ?? 'other')
  if (!category) return { ok: false, error: 'Les catégories de mission ne sont pas disponibles : réessayez dans un instant.' }

  const objective = spec ? spec.objective(who) : text
  const headline = text.split('\n')[0]?.replace(/[.;:,]+$/, '').slice(0, 50) ?? ''
  const name = spec ? spec.name(who) : `${headline} — ${who}`
  const general = category.general_prompt.trim()
  const prompt = [general, `Objectif :\n${objective}`, `Contexte :\n${prospectContextLines(prospect)}`]
    .filter(Boolean)
    .join('\n\n')

  const targets: MissionInput['targets'] = [{ kind: 'prospect', id: prospect.id }]
  const resultKind = kindsForType(category.mission_type)[0]?.resultKind ?? 'enrichment'
  const blocked = missingForRun(category.mission_type, resultKind, targets)
  if (blocked) return { ok: false, error: blocked }

  return {
    ok: true,
    input: {
      name,
      type: category.mission_type,
      category_id: category.id,
      skill_ids: null, // follows the category's skills
      prompt,
      targets,
      source_ids: null, // follows the category's sources
      context_refs: prospect.companyId
        ? [{ kind: 'company', id: prospect.companyId, note: prospect.companyName ?? null }]
        : [],
      agent_id: null,
      is_recurring: false,
      interval_count: 24,
      interval_unit: 'hours',
      starts_at: null,
      end_kind: 'never',
      ends_at: null,
      max_runs: null,
      result_kind: resultKind,
      result_limit: 20,
      objective: { kind: 'tasks_accepted', count: null },
      geography: null,
      period_days: null,
      exclusions: {},
      run_now: false,
    },
  }
}
