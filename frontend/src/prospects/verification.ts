import type { OriginType, Prospect } from '../api/prospects'
import { formatDay } from '../prospection/labels'
import type { StatusTone } from '../ui/Badge'
import { AlertIcon, BanIcon, CheckCircleIcon, ClockIcon, type IconComponent, InfoIcon, MinusCircleIcon } from '../ui/icons'
import { type AliasDraft, type AliasKind, effectiveStatus, type ProspectDraft, valueChanged } from './prospectForm'

// What the Prospect editor says about verification — always a glyph and a text, never colour alone (Task 15):
// imported values never verified and anything to (re)verify in warning style, a recent verification as a subtle
// positive mark with its date, invalid / inactive / do-not-contact with explicit labels.

export interface StateLabel {
  tone: StatusTone
  icon: IconComponent
  text: string
}

const DAY_MS = 86_400_000

// A verification older than the configured threshold (VIPER_VERIFICATION_STALE_DAYS; none by default).
export function isStale(at: string, today: string, staleDays: number | null): boolean {
  if (staleDays === null) return false
  return Date.parse(today) - Date.parse(at) > staleDays * DAY_MS
}

// `YYYY-MM-DD` → « 14 sept. 2026 ».
export function formatDate(day: string): string {
  return formatDay(`${day}T12:00:00Z`)
}

interface EmploymentContext {
  prospect: Prospect | null
  draft: ProspectDraft
  // The company changed in this edit (I-13: employment and verified aliases must be verified again).
  companyMoved: boolean
}

// Employment verification (company, role, exact title, activity): the pending action of this edit first, then the
// company-change rule, then the stored state (the Prospection card's `verification_state`).
export function employmentState({ prospect, draft, companyMoved }: EmploymentContext): StateLabel {
  const { action, day } = draft.verification
  if (action === 'verified_now') return { tone: 'success', icon: CheckCircleIcon, text: 'Vérifié aujourd’hui — à enregistrer' }
  if (action === 'verified_on' && day) return { tone: 'success', icon: CheckCircleIcon, text: `Vérifié le ${formatDate(day)} — à enregistrer` }
  if (action === 'clear') return { tone: 'warning', icon: AlertIcon, text: 'Vérification effacée — à enregistrer' }
  if (companyMoved) return { tone: 'warning', icon: AlertIcon, text: 'Nouvelle entreprise : emploi à vérifier' }
  if (!prospect) return { tone: 'warning', icon: AlertIcon, text: 'Pas encore vérifié' }
  const at = prospect.employment_verified_at ? formatDay(prospect.employment_verified_at) : ''
  switch (prospect.verification_state) {
    case 'never_verified':
      return prospect.employment_imported_unverified
        ? { tone: 'warning', icon: AlertIcon, text: 'Valeurs importées, jamais vérifiées' }
        : { tone: 'warning', icon: AlertIcon, text: 'Emploi jamais vérifié' }
    case 'stale':
      return { tone: 'warning', icon: ClockIcon, text: `Vérifié le ${at} · ancien` }
    case 'channels_reset':
      return { tone: 'warning', icon: ClockIcon, text: `Vérifié le ${at} · coordonnées à revérifier` }
    case 'verified':
      return { tone: 'success', icon: CheckCircleIcon, text: `Vérifié le ${at}` }
  }
}

// The employment fields get the warning outline while their values were imported and never verified.
export function employmentNeedsCheck({ prospect, draft, companyMoved }: EmploymentContext): boolean {
  if (draft.verification.action === 'verified_now' || draft.verification.action === 'verified_on') return false
  return companyMoved || (prospect?.employment_imported_unverified ?? false)
}

interface AliasContext {
  kind: AliasKind
  companyMoved: boolean
  today: string
  staleDays: number | null
}

export function aliasState(alias: AliasDraft, { kind, companyMoved, today, staleDays }: AliasContext): StateLabel {
  if (!alias.is_active) {
    return { tone: 'neutral', icon: MinusCircleIcon, text: kind === 'emails' ? 'Ancienne adresse (inactive)' : 'Ancien numéro (inactif)' }
  }
  if (alias.verified_now) return { tone: 'success', icon: CheckCircleIcon, text: 'Vérifié aujourd’hui — à enregistrer' }
  const stored = alias.stored
  switch (effectiveStatus(kind, alias, companyMoved)) {
    case 'verified': {
      const at = stored?.last_verified_at
      if (at && isStale(at, today, staleDays)) return { tone: 'warning', icon: ClockIcon, text: `Vérifié le ${formatDay(at)} · ancien` }
      return { tone: 'success', icon: CheckCircleIcon, text: at ? `Vérifié le ${formatDay(at)}` : 'Vérifié' }
    }
    case 'invalid':
      return { tone: 'danger', icon: BanIcon, text: 'Invalide' }
    case 'unknown':
      return { tone: 'neutral', icon: InfoIcon, text: 'Statut inconnu' }
    case 'unverified':
      if (stored && !valueChanged(kind, alias) && stored.last_verified_at) {
        return { tone: 'warning', icon: ClockIcon, text: `À revérifier (vérifié le ${formatDay(stored.last_verified_at)})` }
      }
      if (stored?.imported_unverified && !valueChanged(kind, alias)) {
        return { tone: 'warning', icon: AlertIcon, text: 'Importé, jamais vérifié' }
      }
      return { tone: 'warning', icon: AlertIcon, text: 'Non vérifié' }
  }
}

const ORIGINS: Record<OriginType, string> = {
  imported: 'Import',
  manual: 'Saisie manuelle',
  published: 'Source publique',
  inferred: 'Déduit',
  other: 'Autre origine',
}

// « Import · base.xlsx / Prospects / ligne 7 », « Saisie manuelle », or « Nouvelle saisie » before the first save.
export function originLabel(kind: AliasKind, alias: AliasDraft): string {
  const stored = alias.stored
  if (!stored) return 'Nouvelle saisie'
  if (valueChanged(kind, alias)) return 'Corrigé à la main'
  return [ORIGINS[stored.origin_type], stored.source_reference].filter(Boolean).join(' · ')
}
