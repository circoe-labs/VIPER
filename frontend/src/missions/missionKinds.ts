import type { MissionResultKind, MissionType, TargetOption } from '../api/missions'
import {
  CompassIcon,
  type IconComponent,
  MoreIcon,
  PencilIcon,
  RadarIcon,
  ShieldCheckIcon,
  UserPlusIcon,
} from '../ui/icons'

// « Que doit faire l’agent ? »: one tile per (type, expected result) pair the server knows how to run. The pair
// used to be two selects whose valid combinations depended on the linked data — the source of the confusion.
export type MissionKind = 'discover' | 'contacts' | 'signals' | 'enrich' | 'verify' | 'other'

export interface MissionKindSpec {
  id: MissionKind
  type: MissionType
  resultKind: MissionResultKind
  label: string
  icon: IconComponent
  // What the agent does and what it needs, shown on hover.
  help: string
}

export const MISSION_KINDS: MissionKindSpec[] = [
  {
    id: 'discover',
    type: 'prospection',
    resultKind: 'companies',
    label: 'Découvrir des sociétés',
    icon: CompassIcon,
    help: 'L’agent cherche de nouvelles sociétés qui correspondent à la consigne (zone, secteur, événement…). Aucune donnée liée : il part de zéro et propose des fiches à créer.',
  },
  {
    id: 'contacts',
    type: 'prospection',
    resultKind: 'prospects',
    label: 'Trouver des contacts',
    icon: UserPlusIcon,
    help: 'L’agent cherche les bons interlocuteurs dans les sociétés liées. Liez au moins une société.',
  },
  {
    id: 'signals',
    type: 'signals',
    resultKind: 'signals',
    label: 'Surveiller des signaux',
    icon: RadarIcon,
    help: 'L’agent surveille les sociétés liées (recrutements, nouveaux sites, levées…) et remonte les signaux d’achat. Liez au moins une société déjà en base.',
  },
  {
    id: 'enrich',
    type: 'enrichment',
    resultKind: 'enrichment',
    label: 'Compléter des fiches',
    icon: PencilIcon,
    help: 'L’agent complète les fiches liées (site web, domaine e-mail, coordonnées…). Liez des sociétés ou des prospects.',
  },
  {
    id: 'verify',
    type: 'verification',
    resultKind: 'enrichment',
    label: 'Vérifier des fiches',
    icon: ShieldCheckIcon,
    help: 'L’agent vérifie que les fiches liées sont toujours exactes et propose les corrections. Liez des sociétés ou des prospects.',
  },
  {
    id: 'other',
    type: 'other',
    resultKind: 'enrichment',
    label: 'Autre',
    icon: MoreIcon,
    help: 'Une consigne libre sur les fiches liées ; les propositions se relisent comme un enrichissement. Liez des sociétés ou des prospects.',
  },
]

export function kindSpec(kind: MissionKind): MissionKindSpec {
  return MISSION_KINDS.find((item) => item.id === kind) ?? (MISSION_KINDS[3] as MissionKindSpec)
}

// The tile an existing mission belongs to.
export function kindOf(type: MissionType, resultKind: MissionResultKind): MissionKind {
  switch (type) {
    case 'prospection':
      return resultKind === 'prospects' ? 'contacts' : 'discover'
    case 'signals':
      return 'signals'
    case 'enrichment':
      return 'enrich'
    case 'verification':
      return 'verify'
    case 'other':
      return 'other'
  }
}

// Mirror of the server's `check_runnable` (backend/app/services/missions.py): what is missing for the rule to
// produce a task, or null when it can run. The server refuses to save a rule that never could.
export function missingForRun(
  type: MissionType,
  resultKind: MissionResultKind,
  targets: Pick<TargetOption, 'kind'>[],
): string | null {
  const companies = targets.filter((target) => target.kind === 'company').length
  if (type === 'signals') {
    if (resultKind !== 'signals') return 'Une mission de signaux attend le résultat « Signaux ».'
    if (companies === 0) return 'Liez au moins une société à surveiller.'
    return null
  }
  if (targets.length === 0) {
    if (type === 'prospection' && resultKind === 'companies') return null
    return 'Liez au moins une fiche : cette mission travaille sur des sociétés ou des prospects existants.'
  }
  if (type === 'prospection') {
    if (resultKind !== 'prospects') {
      return 'La découverte part de zéro : retirez les données liées, ou choisissez « Trouver des contacts ».'
    }
    if (companies === 0) return 'Liez au moins une société où chercher des contacts.'
  }
  return null
}
