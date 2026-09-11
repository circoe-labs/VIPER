import { describe, expect, it } from 'vitest'

import type { EditAction, EditItem } from '../api/home'
import { describeAction, describeEdit, editOrigin, editSubject, formatMoment } from './activity'

function action(name: string, fields: Partial<EditAction> = {}): EditAction {
  return { action: name, entity_type: name.slice(0, name.indexOf('.')), status_before: null, status_after: null, ...fields }
}

function edit(fields: Partial<EditItem>): EditItem {
  return {
    occurred_at: '2026-09-10T08:00:00+00:00',
    actor_display: 'Pilote Test',
    source: 'ui',
    subject_type: 'prospect',
    subject_id: 'id',
    subject_label: 'Jean Exemple',
    actions: [],
    ...fields,
  }
}

describe('Home activity lines', () => {
  it('names each kind of change in French, with the agreement of its noun', () => {
    expect(describeAction(action('prospect.created'))).toBe('Fiche ajoutée')
    expect(describeAction(action('phone.deleted'))).toBe('Téléphone supprimé')
    expect(describeAction(action('company.updated'))).toBe('Entreprise modifiée')
    expect(describeAction(action('establishment.created'))).toBe('Établissement ajouté')
    expect(describeAction(action('prospect_source.created'))).toBe('Source ajoutée')
    expect(describeAction(action('prospect.company_changed'))).toBe('Changement d’entreprise')
    expect(describeAction(action('prospect.do_not_contact.cleared'))).toBe('Opposition levée')
    expect(describeAction(action('contact_tracking.created', { status_after: 'to_contact' }))).toBe('Suivi : À contacter')
    expect(
      describeAction(action('contact_tracking.status_changed', { status_before: 'contacted', status_after: 'won' })),
    ).toBe('Suivi : Contacté → Gagné')
    expect(describeAction(action('contact_tracking.updated'))).toBe('Suivi de contact modifié')
    // An action this formatter does not know yet never leaks its technical name.
    expect(describeAction(action('prospect.merged'))).toBe('Modification')
  })

  it('reads a save once per kind of change', () => {
    const save = edit({ actions: [action('email.updated'), action('email.updated'), action('phone.created')] })

    expect(describeEdit(save)).toBe('E-mail modifié · Téléphone ajouté')
  })

  it('names a deleted record and the explorer origin', () => {
    expect(editSubject(edit({ subject_label: null }))).toBe('Prospect supprimé')
    expect(editSubject(edit({ subject_type: 'company', subject_label: null }))).toBe('Entreprise supprimée')
    expect(editOrigin(edit({ source: 'database_explorer' }))).toBe('Pilote Test · via Base de données')
    expect(editOrigin(edit({}))).toBe('Pilote Test')
  })

  it('dates in Paris time, without a time for a date stored at midnight', () => {
    expect(formatMoment('2026-09-14T08:30:00+00:00')).toBe('14 sept. à 10:30')
    expect(formatMoment('2026-09-13T22:00:00+00:00')).toBe('14 sept.')
    expect(formatMoment('2026-12-01T23:00:00+00:00')).toBe('2 déc.')
  })
})
