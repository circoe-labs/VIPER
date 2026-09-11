// Readable lines for Home's recent activity (Task 16): the one place that turns audit actions into French. It shows
// what happened and to whom — never field values (the API does not send them). Task 19 replaces it with the full
// history formatter over the same data.
import type { ImportBatch } from '../api/imports'
import type { EditAction, EditItem } from '../api/home'
import { TRACKING_LABELS } from '../prospection/labels'

interface Noun {
  label: string
  feminine: boolean
}

const ENTITIES: Record<string, Noun> = {
  prospect: { label: 'Fiche', feminine: true },
  email: { label: 'E-mail', feminine: false },
  phone: { label: 'Téléphone', feminine: false },
  contact_tracking: { label: 'Suivi de contact', feminine: false },
  prospect_source: { label: 'Source', feminine: true },
  company: { label: 'Entreprise', feminine: true },
  establishment: { label: 'Établissement', feminine: false },
}

const LIFECYCLE: Record<string, string> = { created: 'ajouté', updated: 'modifié', deleted: 'supprimé' }

const SEMANTIC: Record<string, string> = {
  'prospect.company_changed': 'Changement d’entreprise',
  'prospect.do_not_contact.set': 'Opposition enregistrée',
  'prospect.do_not_contact.cleared': 'Opposition levée',
}

// « Suivi : Contacté → Rendez-vous obtenu », « E-mail ajouté », « Fiche modifiée »…
export function describeAction(action: EditAction): string {
  const semantic = SEMANTIC[action.action]
  if (semantic) return semantic
  if (action.status_after) {
    const before = action.status_before ? `${TRACKING_LABELS[action.status_before]} → ` : ''
    return `Suivi : ${before}${TRACKING_LABELS[action.status_after]}`
  }
  const noun = ENTITIES[action.entity_type]
  const verb = LIFECYCLE[action.action.slice(action.action.lastIndexOf('.') + 1)]
  if (!noun || !verb) return 'Modification'
  return `${noun.label} ${verb}${noun.feminine ? 'e' : ''}`
}

// The save's actions, without repeating one (a save that touched two e-mails reads « E-mail modifié » once).
export function describeEdit(edit: EditItem): string {
  return [...new Set(edit.actions.map(describeAction))].join(' · ')
}

// Name of the edited record; a deleted one keeps no name in the feed.
export function editSubject(edit: EditItem): string {
  if (edit.subject_label) return edit.subject_label
  return edit.subject_type === 'company' ? 'Entreprise supprimée' : 'Prospect supprimé'
}

export function editOrigin(edit: EditItem): string {
  return edit.source === 'database_explorer' ? `${edit.actor_display} · via Base de données` : edit.actor_display
}

// « 12 lignes importées sur 14 · 2 exclues ».
export function importCounts(batch: ImportBatch): string {
  const lines = `${String(batch.rows_imported)} ${batch.rows_imported > 1 ? 'lignes importées' : 'ligne importée'} sur ${String(batch.rows_total)}`
  return batch.rows_skipped > 0 ? `${lines} · ${String(batch.rows_skipped)} exclue${batch.rows_skipped > 1 ? 's' : ''}` : lines
}

const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })
const PARIS_TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

// « 14 sept. à 10:30 », or « 14 sept. » for a date stored at midnight (a day without time), in Circoe's time zone.
export function formatMoment(iso: string): string {
  const date = new Date(iso)
  const time = PARIS_TIME.format(date)
  return time === '00:00' ? DAY.format(date) : `${DAY.format(date)} à ${time}`
}
