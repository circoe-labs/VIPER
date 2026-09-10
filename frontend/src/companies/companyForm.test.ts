import { describe, expect, it } from 'vitest'

import {
  type CompanyDraft,
  digitsOf,
  emptyDraft,
  isDirty,
  luhnValid,
  newEstablishment,
  normalizeEmailDomain,
  siretKeyValid,
  suggestedEmailDomain,
  toInput,
  validate,
  websiteHost,
} from './companyForm'

// Synthetic identifiers: 999000011 passes the Luhn key, 999000012 does not.
const SIREN = '999000011'

function draft(changes: Partial<CompanyDraft> = {}): CompanyDraft {
  return { ...emptyDraft(), display_name: 'Transports Exemple', ...changes }
}

function site(changes: Partial<ReturnType<typeof newEstablishment>> = {}) {
  return { ...newEstablishment(false), ...changes }
}

describe('identifiers', () => {
  it('checks the Luhn key, and the digit sum for La Poste establishments', () => {
    expect(luhnValid(SIREN)).toBe(true)
    expect(luhnValid('999000012')).toBe(false)
    expect(siretKeyValid('99900001100018')).toBe(true)
    expect(siretKeyValid('35600000000010')).toBe(true)
    expect(luhnValid('35600000000010')).toBe(false)
    expect(siretKeyValid('35600000000011')).toBe(false)
  })

  it('ignores regular and no-break spaces', () => {
    expect(digitsOf(' 999 000 011 ')).toBe(SIREN)
  })
})

describe('web values', () => {
  it.each([
    ['exemple.fr', 'exemple.fr'],
    ['https://www.Exemple.fr/contact', 'www.exemple.fr'],
    ['exemple', null],
    ['ftp://exemple.fr', null],
    ['https://jean@exemple.fr', null],
    ['exe mple.fr', null],
  ])('website %s → host %s', (value, host) => {
    expect(websiteHost(value)).toBe(host)
  })

  it.each([
    ['@Exemple.FR', 'exemple.fr'],
    ['jean.test@exemple.fr', 'exemple.fr'],
    ['https://www.exemple.fr/contact', 'exemple.fr'],
    ['exemple.fr.', 'exemple.fr'],
  ])('e-mail domain %s → %s', (value, domain) => {
    expect(normalizeEmailDomain(value)).toBe(domain)
  })

  it('suggests the website host as e-mail domain only while the domain is empty', () => {
    expect(suggestedEmailDomain(draft({ website_url: 'www.exemple.fr' }))).toBe('exemple.fr')
    expect(suggestedEmailDomain(draft({ website_url: 'www.exemple.fr', email_domain: 'autre.fr' }))).toBeNull()
    expect(suggestedEmailDomain(draft({ website_url: 'pas un site' }))).toBeNull()
  })
})

describe('payload and dirty state', () => {
  it('trims texts, collapses single lines, strips identifier spaces and turns blanks into null', () => {
    const input = toInput(
      draft({
        display_name: '  Transports   Exemple ',
        legal_name: '   ',
        siren: '999 000 011',
        client_approach: '  Première ligne\n  seconde  ',
        establishments: [site({ name: ' Siège  principal ', siret: '999 000 011 00018', city: '' })],
      }),
    )
    expect(input).toMatchObject({
      display_name: 'Transports Exemple',
      legal_name: null,
      siren: SIREN,
      client_approach: 'Première ligne\n  seconde',
    })
    expect(input.establishments[0]).toMatchObject({ id: null, name: 'Siège principal', siret: '99900001100018', city: null })
  })

  it('is dirty only when the payload changes', () => {
    const saved = draft({ siren: SIREN })
    expect(isDirty(draft({ siren: '999 000 011', display_name: ' Transports Exemple ' }), saved)).toBe(false)
    expect(isDirty(draft({ siren: SIREN, size_label: '10-49' }), saved)).toBe(true)
    expect(isDirty(draft({ siren: SIREN, establishments: [site()] }), saved)).toBe(true)
  })
})

describe('validate', () => {
  it('requires the name and bounds the lengths', () => {
    expect(validate(draft({ display_name: '  ' }), emptyDraft()).errors.display_name).toBe('Saisissez le nom de l’entreprise.')
    expect(validate(draft({ legal_name: 'x'.repeat(256) }), emptyDraft()).errors.legal_name).toBe('255 caractères au plus.')
  })

  it('refuses a malformed or wrong SIREN, but only warns about an unchanged stored one', () => {
    expect(validate(draft({ siren: '12345' }), emptyDraft()).errors.siren).toBe('Le SIREN comporte 9 chiffres.')
    expect(validate(draft({ siren: '999000012' }), emptyDraft()).errors.siren).toMatch(/n’est pas valide/)
    const imported = draft({ siren: '000000001' })
    const { errors, warnings } = validate(imported, imported)
    expect(errors.siren).toBeUndefined()
    expect(warnings.siren).toMatch(/enregistré ne respecte pas la clé/)
  })

  it('checks each SIRET: format, key, repeats, and warns when it does not start with the SIREN', () => {
    const { errors, warnings } = validate(
      draft({
        siren: SIREN,
        establishments: [
          site({ siret: '99900001100018' }),
          site({ siret: '99900001100018' }),
          site({ siret: '1234' }),
          site({ siret: '99900001100019' }),
          site({ siret: '99900002000001' }),
        ],
      }),
      emptyDraft(),
    )
    expect(errors).toEqual({
      'establishments.1.siret': 'Ce SIRET est déjà saisi pour un autre établissement.',
      'establishments.2.siret': 'Le SIRET comporte 14 chiffres.',
      'establishments.3.siret': 'Ce SIRET n’est pas valide : un chiffre est sans doute erroné (clé de contrôle).',
    })
    expect(warnings).toEqual({
      'establishments.4.siret': 'Ce SIRET ne commence pas par le SIREN de l’entreprise (999 000 011) : vérifiez-le.',
    })
  })

  it('refuses an invalid website or e-mail domain', () => {
    const { errors } = validate(draft({ website_url: 'exemple', email_domain: 'pas un domaine' }), emptyDraft())
    expect(errors.website_url).toBe('Adresse de site invalide (ex. www.exemple.fr).')
    expect(errors.email_domain).toBe('Domaine invalide : saisissez par exemple exemple.fr.')
  })
})
