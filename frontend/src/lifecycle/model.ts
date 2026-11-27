import type { Block, DepartureReason, Hold, Lifecycle, LifecycleAction } from '../api/lifecycle'

// The words of the prospecting lifecycle: one place, read by badges, banners, dialogs, mail editor and lists.
export const BLOCK_LABELS: Record<Block, string> = {
  prospect_do_not_contact: 'Ne pas contacter',
  prospect_departed: 'Plus en poste',
  prospect_archived: 'Archivé',
  company_archived: 'Entreprise archivée',
  prospect_excluded: 'Exclu temporairement',
  company_excluded: 'Entreprise exclue',
}

export const DEPARTURE_LABELS: Record<DepartureReason, string> = {
  retired: 'À la retraite',
  left_company: 'A quitté l’entreprise',
  other: 'Parti (autre motif)',
}

export function isBlock(code: string | null | undefined): code is Block {
  return code != null && code in BLOCK_LABELS
}

export interface LifecycleChoice {
  id: string
  label: string
  action: LifecycleAction
  departure_reason?: DepartureReason
  // A reason is required (excluding, bringing back).
  reasonRequired: boolean
  reasonLabel: string
}

const NOTE = 'Note (facultatif)'

function choice(action: LifecycleAction, label: string, reason: string = NOTE): LifecycleChoice {
  return { id: action, label, action, reasonRequired: reason !== NOTE, reasonLabel: reason }
}

export function ownHold(state: Lifecycle, type: 'prospect' | 'company', kind: Hold['kind']): Hold | undefined {
  return state.holds.find((hold) => hold.scope === type && hold.kind === kind)
}

// What can be done now. `departed`: the person's activity is « Inactif ».
export function statusChoices(state: Lifecycle, type: 'prospect' | 'company', departed: boolean): LifecycleChoice[] {
  const departures = (Object.keys(DEPARTURE_LABELS) as DepartureReason[]).map(
    (reason): LifecycleChoice => ({ ...choice('depart', DEPARTURE_LABELS[reason]), id: `depart-${reason}`, departure_reason: reason }),
  )
  return [
    ...(type === 'company' ? [] : departed ? [choice('return', 'De retour en poste (emploi à vérifier)')] : departures),
    ownHold(state, type, 'exclusion')
      ? choice('reinstate', 'Réintégrer dans la prospection', 'Nouvelle information ou nouvel angle')
      : choice('exclude', 'Exclure temporairement de la prospection', 'Motif de l’exclusion'),
    ownHold(state, type, 'archive') ? choice('unarchive', 'Désarchiver') : choice('archive', 'Archiver'),
  ]
}
