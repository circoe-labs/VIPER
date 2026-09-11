import { describe, expect, it } from 'vitest'

import type { EmailAlias, PhoneAlias } from '../api/prospects'
import { prospectDetail } from '../test/prospectsApi'
import {
  draftFromProspect,
  effectiveStatus,
  emptyDraft,
  isDirty,
  isoWeekLabel,
  newAlias,
  normalizePhone,
  payloadIndexes,
  suggestedPhoneType,
  toCreateInput,
  toInput,
  validate,
} from './prospectForm'

const VERIFIED = '2026-06-01T10:00:00+00:00'

function email(fields: Partial<EmailAlias> = {}): EmailAlias {
  return {
    id: 'e1',
    address: 'jean@exemple.example',
    is_primary: true,
    is_active: true,
    verification_status: 'verified',
    last_verified_at: VERIFIED,
    origin_type: 'imported',
    source_reference: 'base.xlsx / Prospects / ligne 7',
    imported_unverified: false,
    ...fields,
  }
}

function phone(fields: Partial<PhoneAlias> = {}): PhoneAlias {
  return { ...email(), id: 'p1', number: '+33612345678', type: 'mobile', ...fields }
}

describe('prospect form model', () => {
  it('loads a prospect into a draft whose payload is unchanged (not dirty)', () => {
    const prospect = prospectDetail({
      company: { id: 'c1', display_name: 'Transports Exemple SARL', legal_name: null, siren: null, email_domain: null, website_url: null, commercial_segment_label: null, city: null, prospect_count: 1 },
      emails: [email()],
      phones: [phone()],
      tracking: {
        status: 'contacted',
        planned_contact_on: '2026-09-14',
        planned_contact_week: '2026-W38',
        response_received_on: null,
        appointment_on: '2026-09-22',
        appointment_time: '10:30:00',
        referent: null,
        status_since: null,
      },
    })
    const draft = draftFromProspect(prospect)

    expect(draft.phones[0]?.value).toBe('+33 6 12 34 56 78')
    expect(draft.tracking.appointment_time).toBe('10:30')
    expect(isDirty(draft, draft, false)).toBe(false)
    const input = toInput(draft, 'c1')
    expect(input.phones[0]).toMatchObject({ number: '+33 6 12 34 56 78', type: 'mobile', verification_status: 'verified' })
    expect(input.tracking).toEqual({
      status: 'contacted',
      planned_contact_on: '2026-09-14',
      response_received_on: null,
      appointment_on: '2026-09-22',
      appointment_time: '10:30',
      referent_id: null,
    })
    expect(input.employment_verification).toEqual({ action: 'keep', day: null })
  })

  it('sends a stored alias source back exactly as stored (an import sheet name keeps its spacing)', () => {
    const reference = 'base.xlsx / Base client  / ligne 2'
    const draft = draftFromProspect(prospectDetail({ emails: [email({ source_reference: reference })] }))

    expect(toInput(draft, null).emails[0]?.source_reference).toBe(reference)
  })

  it('leaves blank new lines out of the payload and maps payload indexes back to the draft', () => {
    const draft = emptyDraft({ company_id: 'c1' })
    const typed = { ...newAlias('emails', false), value: 'b@exemple.example' }
    draft.emails = [...draft.emails, typed]

    const input = toCreateInput(draft)

    expect(input.emails.map((item) => item.address)).toEqual(['b@exemple.example'])
    expect(input.phones).toEqual([])
    expect(payloadIndexes(draft.emails)).toEqual([1])
    expect(input.provenance.legal_basis_or_collection_context).toBe('Saisie manuelle — prospection B2B')
    expect(input.tracking).toBeNull()
  })

  it('creates a tracking at « À contacter » as soon as a date is planned', () => {
    const draft = emptyDraft()
    draft.tracking = { ...draft.tracking, planned_contact_on: '2026-09-21' }

    expect(toInput(draft, null).tracking).toMatchObject({ status: 'to_contact', planned_contact_on: '2026-09-21' })
  })

  it('normalizes phone numbers like the server and suggests their type', () => {
    expect(normalizePhone('06 12 34 56 78')).toBe('+33612345678')
    expect(normalizePhone('+33 (0)1 23 45 67 89')).toBe('+33123456789')
    expect(normalizePhone('0033 7 00 00 00 01')).toBe('+33700000001')
    expect(normalizePhone('+44 20 7946 0000')).toBe('+442079460000')
    expect(normalizePhone('06 12')).toBeNull()
    expect(normalizePhone('appeler le matin')).toBeNull()
    expect(suggestedPhoneType('07 00 00 00 01')).toBe('mobile')
    expect(suggestedPhoneType('01 23 45 67 89')).toBe('landline')
    expect(suggestedPhoneType('08 00 00 00 00')).toBe('other')
    expect(suggestedPhoneType('+44 20 7946 0000')).toBeNull()
  })

  it('applies the verification rules of the server: explicit, per value, reset by a company change', () => {
    const [stored] = draftFromProspect(prospectDetail({ emails: [email()] })).emails
    if (!stored) throw new Error('no alias')

    expect(effectiveStatus('emails', stored, false)).toBe('verified')
    // A company change sends the verified active alias back to « non vérifié » (I-13)…
    expect(effectiveStatus('emails', stored, true)).toBe('unverified')
    // …unless the user verifies it again in the same edit.
    expect(effectiveStatus('emails', { ...stored, verified_now: true }, true)).toBe('verified')
    // A corrected address was never verified.
    expect(effectiveStatus('emails', { ...stored, value: 'jean.dupont@exemple.example' }, false)).toBe('unverified')
    // Case and spaces are not a new value.
    expect(effectiveStatus('emails', { ...stored, value: ' JEAN@exemple.example ' }, false)).toBe('verified')
  })

  it('validates in French before sending', () => {
    const draft = emptyDraft()
    draft.emails = [{ ...newAlias('emails', true), value: 'pas-une-adresse' }, { ...newAlias('emails', false), value: 'A@b.fr' }, { ...newAlias('emails', false), value: 'a@b.fr' }]
    draft.phones = [{ ...newAlias('phones', true), value: '06 12' }]
    draft.verification = { action: 'verified_on', day: '2026-09-12' }
    draft.tracking = { ...draft.tracking, appointment_time: '10:00' }
    draft.legal_context = ' '

    expect(validate(draft, { isNew: true, today: '2026-09-11' })).toEqual({
      last_name: 'Saisissez au moins un prénom ou un nom.',
      company_id: 'Choisissez l’entreprise, ou créez-la depuis ce champ.',
      'employment_verification.day': 'La date de vérification ne peut pas être dans le futur.',
      'emails.0.address': 'Adresse e-mail invalide (ex. prenom.nom@exemple.fr).',
      'emails.2.address': 'Cette adresse est déjà saisie.',
      'phones.0.number': 'Numéro invalide : 10 chiffres pour la France (06 12 34 56 78), ou +indicatif.',
      'tracking.appointment_time': 'Indiquez aussi le jour du rendez-vous.',
      'provenance.legal_basis_or_collection_context': 'Indiquez le contexte de collecte (ou la base légale).',
    })
  })

  it('derives the planned-contact week (ISO 8601)', () => {
    expect(isoWeekLabel('2026-09-14')).toBe('S38')
    expect(isoWeekLabel('2027-01-01')).toBe('S53')
    expect(isoWeekLabel('')).toBeNull()
  })
})
