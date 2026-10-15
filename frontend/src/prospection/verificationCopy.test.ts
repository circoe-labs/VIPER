import { describe, expect, it } from 'vitest'

import { type FicheSnapshot, toExcelRow, toJson, toPlainText, toPrompt } from './verificationCopy'

const fiche: FicheSnapshot = {
  entreprise: 'GPMR',
  ville: 'ROUEN CEDEX',
  site_web: '',
  domaine_email: 'haropaport.com',
  civilite: 'Mme',
  prenom: 'Véronique',
  nom: 'Duprey Saint-Denis',
  fonction: 'Commercial delegate',
  emails: ['veronique.saintdenis@haropaports.com'],
  telephones: [],
  source: 'norm.xlsx',
  doutes: [],
}

describe('verificationCopy', () => {
  it('builds a tab-separated Excel row', () => {
    expect(toExcelRow(fiche)).toBe(
      'Duprey Saint-Denis\tVéronique\tveronique.saintdenis@haropaports.com\t\tCommercial delegate\tGPMR',
    )
  })

  it('writes readable text with a dash for empty values', () => {
    expect(toPlainText(fiche)).toContain('Téléphone : —')
    expect(toPlainText(fiche)).toContain('Nom : Duprey Saint-Denis')
  })

  it('writes JSON that parses back', () => {
    expect(JSON.parse(toJson(fiche))).toEqual(fiche)
  })

  it('lists what is known and what is missing in the prompt', () => {
    const prompt = toPrompt(fiche)
    expect(prompt).toContain('- Entreprise : GPMR')
    expect(prompt).toContain('Il manque : Site web, Téléphone.')
    expect(prompt).not.toContain('Doutes déjà signalés')
    expect(toPrompt({ ...fiche, doutes: ['Fonction à vérifier'] })).toContain('- Fonction à vérifier')
  })
})
