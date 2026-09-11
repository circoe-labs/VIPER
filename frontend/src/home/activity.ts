// Readable lines for Home's recent activity. What a save did comes already worded, without any value, from the history
// formatter (Task 19, backend/app/services/history.py): Home shows what changed and to whom, the editors' history
// shows the values. This module names the record and the origin and formats counts and dates.
import type { EditItem } from '../api/home'
import type { ImportBatch } from '../api/imports'
import { actorName } from '../history/format'

// « Changement d’entreprise · E-mail principal modifié · Suivi : Contacté → Relance 1 ».
export function describeEdit(edit: EditItem): string {
  return edit.summary.join(' · ')
}

// Name of the edited record; a deleted one keeps no name in the feed.
export function editSubject(edit: EditItem): string {
  if (edit.subject_label) return edit.subject_label
  return edit.subject_type === 'company' ? 'Entreprise supprimée' : 'Prospect supprimé'
}

export function editOrigin(edit: EditItem): string {
  const who = actorName(edit.actor)
  return edit.source === 'database_explorer' ? `${who} · via Base de données` : who
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
