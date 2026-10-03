import { expect, type Locator, type Page, test } from '@playwright/test'

import { importProspects, uniqueSuffix } from './data'
import { SCREENSHOTS } from './helpers'
import { signIn } from './session'

// Prospect editor (Task 15) against the real backend. Every test imports or creates its own synthetic people (names and
// company carry a `uniqueSuffix()` tag) and narrows Prospection to them with that tag, so counts are its own (I-81).

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.use({ viewport: { width: 1440, height: 900 } })

function card(page: Page, label: string) {
  return page.getByRole('region', { name: 'Compteurs' }).getByRole('button', { name: new RegExp(`^${label}`) })
}

async function expectCount(page: Page, label: string, count: number) {
  await expect(card(page, label).locator('.counter-card__count')).toHaveText(String(count))
}

function people(page: Page) {
  return page.getByRole('list', { name: 'Prospects' })
}

async function searchTag(page: Page, tag: string) {
  await page.goto('/prospection')
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  await expect(page).toHaveURL(new RegExp(`q=${tag}`))
}

function region(scope: Locator, name: string) {
  return scope.getByRole('region', { name })
}

// The editor's tabs (Profil / Suivi) and the read/edit switch of its Profil sections.
async function showTab(editor: Locator, name: 'Profil' | 'Suivi') {
  await editor.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
  await expect(editor.getByRole('tab', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-selected', 'true')
}

// Opens a Profil section as inputs (nothing to do when it already is: an invalid one opens that way).
async function editSection(editor: Locator, name: string) {
  const edit = region(editor, name).getByRole('button', { name: `Modifier : ${name}` })
  if (await edit.isVisible()) await edit.click()
}

test('verify, add a primary e-mail, plan the contact, then Save & Next through the filtered queue', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PED${suffix}`
  const company = `Transports ${tag}`
  await importProspects(page, `editeur-${suffix}.xlsx`, [
    { company, civility: 'M.', first_name: 'Jean', last_name: `Arnaud${suffix}`, email: `jean@${tag.toLowerCase()}.example` },
    { company, civility: 'Mme', first_name: 'Claire', last_name: `Bertin${suffix}`, email: `claire@${tag.toLowerCase()}.example` },
    { company, civility: 'M.', first_name: 'Hugo', last_name: `Caron${suffix}`, mobile: '06 00 00 00 03' },
  ])

  await searchTag(page, tag)
  // The page has rendered the search before the card is pressed (under load, a click on the previous render would
  // carry that render's criteria).
  await expect(people(page).getByRole('listitem')).toHaveCount(3)
  await card(page, 'Jamais vérifiés').click()
  await expect(people(page).getByRole('listitem')).toHaveCount(3)
  await people(page).getByRole('link', { name: `Jean Arnaud${suffix}` }).click()

  const editor = page.getByRole('dialog', { name: `M. Jean Arnaud${suffix}` })
  await expect(editor).toHaveAccessibleDescription('Prospect 1 sur 3 · Jamais vérifiés')
  // The profile reads as a summary; the employment verification is a secondary line of the Emploi section.
  await expect(region(editor, 'Résumé du profil')).toContainText(`jean@${tag.toLowerCase()}.example`)
  await expect(editor.getByRole('textbox', { name: 'Prénom' })).toHaveCount(0)
  const verification = region(editor, 'Emploi').getByRole('group', { name: 'Vérification de l’emploi' })
  await expect(verification).toContainText('Valeurs importées, jamais vérifiées')
  await verification.getByRole('button', { name: 'Vérifié aujourd’hui' }).click()

  await editSection(editor, 'E-mails')
  const emails = region(editor, 'E-mails')
  await emails.getByRole('button', { name: 'Ajouter un e-mail' }).click()
  await emails.getByRole('textbox', { name: 'Adresse e-mail' }).nth(1).fill(`j.arnaud@${tag.toLowerCase()}.example`)
  await emails.getByRole('radio', { name: 'Principal' }).nth(1).check()

  await showTab(editor, 'Suivi')
  const tracking = region(editor, 'Suivi de contact')
  await tracking.getByRole('button', { name: '+1 semaine' }).click()
  await tracking.getByRole('combobox', { name: 'État' }).selectOption({ label: 'Contacté' })
  await expect(tracking.getByRole('group', { name: 'Prochaine action' })).toContainText('dans 1 semaine')
  // The changes made on Profil wait on the tab that is not shown, and say so.
  await expect(editor.getByRole('tab', { name: /^Profil.*modifications non enregistrées/ })).toBeVisible()

  await editor.getByRole('button', { name: 'Enregistrer et suivant' }).click()

  // Arnaud left « Jamais vérifiés » (the list behind now counts 2); the queue keeps the order it was opened with.
  const next = page.getByRole('dialog', { name: `Mme Claire Bertin${suffix}` })
  await expect(next).toBeVisible()
  await expect(next).toHaveAccessibleDescription('Prospect 2 sur 3 · Jamais vérifiés')
  // The next person opens on Profil, as a summary.
  await expect(next.getByRole('tab', { name: 'Profil' })).toHaveAttribute('aria-selected', 'true')
  await expectCount(page, 'Jamais vérifiés', 2)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await card(page, 'Tous').click()
  const saved = people(page).getByRole('listitem').filter({ hasText: `Arnaud${suffix}` })
  await expect(saved).toContainText(`j.arnaud@${tag.toLowerCase()}.example`)
  await expect(saved).toContainText('Vérifié le')
  await expect(saved).toContainText('Contacté')
})

test('add a new prospect with a company created inline', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PEN${suffix}`
  const company = `Société ${tag}`
  await page.goto('/prospection')
  await page.getByRole('button', { name: 'Ajouter un prospect' }).click()

  const editor = page.getByRole('dialog', { name: 'Nouveau prospect' })
  await editor.getByRole('textbox', { name: 'Prénom' }).fill('Nina')
  await editor.getByRole('textbox', { name: 'Nom', exact: true }).fill(`Nouvelle${suffix}`)
  const picker = editor.getByRole('combobox', { name: /Entreprise/ })
  await picker.fill(company)
  await editor.getByRole('option', { name: `Créer l’entreprise « ${company} »` }).click()

  const companyEditor = page.getByRole('dialog', { name: 'Nouvelle entreprise' })
  await expect(companyEditor.getByRole('textbox', { name: /Nom de l’entreprise/ })).toHaveValue(company)
  await companyEditor.getByRole('button', { name: 'Enregistrer' }).click()
  const savedCompany = page.getByRole('dialog', { name: company })
  await expect(savedCompany.getByText('Entreprise enregistrée.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(savedCompany).toBeHidden()
  await expect(picker).toHaveValue(company)

  await region(editor, 'E-mails').getByRole('textbox', { name: 'Adresse e-mail' }).fill(`nina@${tag.toLowerCase()}.example`)
  await showTab(editor, 'Suivi')
  await expect(region(editor, 'Provenance').getByRole('textbox', { name: /Contexte de collecte/ })).toHaveValue(
    'Saisie manuelle — prospection B2B',
  )
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()

  const created = page.getByRole('dialog', { name: `Nina Nouvelle${suffix}` })
  await expect(created.getByText('Prospect enregistré.')).toBeVisible()
  await showTab(created, 'Suivi')
  await expect(region(created, 'Provenance')).toContainText('Saisie manuelle')
  await page.keyboard.press('Escape')

  await searchTag(page, tag)
  await expectCount(page, 'Tous', 1)
  await expect(people(page)).toContainText(`Nina Nouvelle${suffix}`)
  await expect(people(page)).toContainText(company)
})

test('an opposition recorded with its reason is counted under Opposition', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PEO${suffix}`
  await importProspects(page, `opposition-${suffix}.xlsx`, [
    { company: `Transports ${tag}`, civility: 'Mme', first_name: 'Léa', last_name: `Oppose${suffix}`, email: `lea@${tag.toLowerCase()}.example` },
  ])

  await searchTag(page, tag)
  await expectCount(page, 'Opposition', 0)
  await people(page).getByRole('link', { name: `Léa Oppose${suffix}` }).click()
  const editor = page.getByRole('dialog', { name: `Mme Léa Oppose${suffix}` })
  await showTab(editor, 'Suivi')
  await region(editor, 'Opposition').getByRole('button', { name: 'Enregistrer une opposition…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Enregistrer une opposition ?' })
  await confirm.getByRole('textbox', { name: /Motif/ }).fill('Demande de l’intéressée (synthétique)')
  await confirm.getByRole('button', { name: 'Enregistrer l’opposition' }).click()

  await expect(region(editor, 'Opposition')).toContainText('Ne pas contacter')
  await expect(region(editor, 'Opposition')).toContainText('Motif : Demande de l’intéressée (synthétique)')
  await page.keyboard.press('Escape')
  await expectCount(page, 'Opposition', 1)
  await expectCount(page, 'À contacter', 0)
  await card(page, 'Opposition').click()
  await expect(people(page)).toContainText('Ne pas contacter')
})

const VIEWPORTS = [
  [1440, 900],
  [1280, 800],
] as const

// Nothing widens the page or the drawer's scrolling body: the content wraps instead.
async function expectNoOverflow(page: Page, editor: Locator, width: number, { wholePage = true } = {}) {
  if (wholePage) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  const body = await editor.locator('.dialog__body').evaluate((element) => ({ scroll: element.scrollWidth, shown: element.clientWidth }))
  expect(body.scroll).toBeLessThanOrEqual(body.shown)
}

async function screenshots(page: Page, state: string) {
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((value) => {
      window.localStorage.setItem('viper.theme', value)
    }, theme)
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height })
      await page.reload()
      const editor = page.getByRole('dialog').first()
      await expect(editor.getByRole('region', { name: 'Résumé du profil' })).toBeVisible()
      await expect(editor.getByRole('region', { name: 'Entreprise' })).not.toContainText('Chargement')
      await page.mouse.move(0, 0)
      const shot = (name: string) => page.screenshot({ path: `${SCREENSHOTS}/prospect-editor-${state}-${name}${theme}-${String(width)}.png`, animations: 'disabled' })
      // Profil as a summary, then its sections as inputs, then the Suivi tab.
      await shot('')
      await expectNoOverflow(page, editor, width)
      for (const name of ['Identité', 'E-mails', 'Téléphones', 'Emploi']) await editSection(editor, name)
      await editor.getByRole('region', { name: 'Téléphones' }).scrollIntoViewIfNeeded()
      await shot('aliases-')
      await expectNoOverflow(page, editor, width)
      await showTab(editor, 'Suivi')
      const tracking = editor.getByRole('region', { name: 'Suivi de contact' })
      await tracking.scrollIntoViewIfNeeded()
      await tracking.screenshot({ path: `${SCREENSHOTS}/prospect-editor-${state}-tracking-${theme}-${String(width)}.png`, animations: 'disabled' })
      await expectNoOverflow(page, editor, width)
    }
  }
}

test('notes: quick add with Enter (the editor stays open), edit in place, delete after confirmation, and a long list stays bounded', async ({ page }) => {
  test.setTimeout(90_000)
  const suffix = uniqueSuffix()
  const tag = `PEQ${suffix}`
  await importProspects(page, `notes-${suffix}.xlsx`, [
    { company: `Transports ${tag}`, civility: 'M.', first_name: 'Noé', last_name: `Notes${suffix}`, email: `noe@${tag.toLowerCase()}.example` },
  ])
  await searchTag(page, tag)
  await people(page).getByRole('link', { name: `Noé Notes${suffix}` }).click()
  const editor = page.getByRole('dialog', { name: `M. Noé Notes${suffix}` })
  await showTab(editor, 'Suivi')
  const notes = region(editor, 'Notes')
  await expect(notes).toContainText('Aucune note pour l’instant.')

  // Enter adds the note: the prospect is neither saved nor left, and the form stays clean.
  const fact = notes.getByRole('textbox', { name: 'Nouveau fait' })
  await fact.fill('A liké notre post LinkedIn')
  await fact.press('Enter')
  await expect(notes.getByRole('list', { name: 'Liste des notes' })).toContainText('A liké notre post LinkedIn')
  await expect(editor).toContainText('Prospect 1 sur 1')
  await expect(editor.getByRole('button', { name: 'Enregistrer', exact: true })).toBeDisabled()
  await expect(fact).toBeFocused()

  // A score impact, then an edit in place.
  await fact.fill('Texte très long '.repeat(30))
  await notes.getByRole('button', { name: 'Impact sur le score…' }).click()
  await notes.getByRole('textbox', { name: 'Impact sur le score' }).fill('-10')
  await fact.press('Enter')
  await expect(notes.getByRole('img', { name: 'Impact sur le score : -10' })).toBeVisible()
  const first = notes.getByRole('listitem').filter({ hasText: 'A liké' })
  await first.hover()
  await first.getByRole('button', { name: /^Actions : / }).click()
  await page.getByRole('menuitem', { name: 'Modifier' }).click()
  const edit = notes.getByRole('group', { name: 'Modifier la note' })
  await edit.getByRole('textbox', { name: 'Fait', exact: true }).fill('A liké notre post LinkedIn sur IGuard')
  await edit.getByRole('textbox', { name: 'Impact sur le score' }).fill('+5')
  await edit.getByRole('button', { name: 'Enregistrer la note' }).click()
  await expect(notes.getByRole('img', { name: 'Impact sur le score : +5' })).toBeVisible()
  await expect(notes).toContainText('sur IGuard')

  // Many notes: the list scrolls inside the section, the page does not grow sideways.
  for (let index = 0; index < 12; index += 1) {
    await fact.fill(`Fait de remplissage numéro ${String(index)}`)
    await fact.press('Enter')
    await expect(notes.getByRole('list', { name: 'Liste des notes' })).toContainText(`numéro ${String(index)}`)
  }
  const list = notes.getByRole('list', { name: 'Liste des notes' })
  const box = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight, width: element.scrollWidth, shown: element.clientWidth }))
  expect(box.scroll).toBeGreaterThan(box.client)
  expect(box.client).toBeLessThanOrEqual(360)
  expect(box.width).toBeLessThanOrEqual(box.shown)

  await notes.screenshot({ path: `${SCREENSHOTS}/prospect-editor-notes.png`, animations: 'disabled' })

  // Deletion asks first.
  const filler = notes.getByRole('listitem').filter({ hasText: 'numéro 0' })
  await filler.hover()
  await filler.getByRole('button', { name: /^Actions : / }).click()
  await page.getByRole('menuitem', { name: 'Supprimer' }).click()
  await page.getByRole('dialog', { name: 'Supprimer cette note ?' }).getByRole('button', { name: 'Supprimer la note' }).click()
  await expect(notes).not.toContainText('numéro 0')
  await expect(page.getByRole('dialog', { name: 'Supprimer cette note ?' })).toBeHidden()

  // The notes are stored: a fresh read of the prospect shows them again.
  await page.reload()
  await showTab(page.getByRole('dialog').first(), 'Suivi')
  await expect(region(page.getByRole('dialog').first(), 'Notes')).toContainText('sur IGuard')
})

test('editor screenshots: imported values to verify, then verified (dark/light, 1440 and 1280 px)', async ({ page }) => {
  test.setTimeout(90_000)
  const suffix = uniqueSuffix()
  const tag = `PES${suffix}`
  await importProspects(page, `captures-${suffix}.xlsx`, [
    {
      company: `Transports ${tag}`,
      civility: 'M.',
      first_name: 'Paul',
      last_name: `Capture${suffix}`,
      job: 'Responsable exploitation (synthétique)',
      email: `paul@${tag.toLowerCase()}.example`,
      mobile: '06 00 00 00 07',
    },
  ])
  await searchTag(page, tag)
  await people(page).getByRole('link', { name: `Paul Capture${suffix}` }).click()
  await expect(page).toHaveURL(/prospect=/)

  await screenshots(page, 'to-verify')

  const editor = page.getByRole('dialog').first()
  await showTab(editor, 'Profil')
  await editSection(editor, 'Emploi')
  await editor.getByRole('radio', { name: 'Actif', exact: true }).check()
  await editor.getByRole('button', { name: 'Vérifié aujourd’hui' }).click()
  await editSection(editor, 'E-mails')
  await editSection(editor, 'Téléphones')
  await region(editor, 'E-mails').getByRole('button', { name: 'Vérifié', exact: true }).click()
  await region(editor, 'Téléphones').getByRole('button', { name: 'Vérifié', exact: true }).click()
  await showTab(editor, 'Suivi')
  await region(editor, 'Suivi de contact').getByRole('button', { name: '+1 semaine' }).click()
  await region(editor, 'Suivi de contact').getByRole('combobox', { name: 'État' }).selectOption({ label: 'Contacté' })
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(editor.getByText('Prospect enregistré.')).toBeVisible()
  // Saved: every section reads as a summary again.
  await expect(editor.getByRole('textbox', { name: 'Prénom' })).toHaveCount(0)
  await showTab(editor, 'Profil')
  await expect(region(editor, 'Emploi').getByRole('group', { name: 'Vérification de l’emploi' })).toContainText('Vérifié le')
  await showTab(editor, 'Suivi')

  // Saved « Contacté »: the cadence week (+2) is offered, not applied.
  await expect(region(editor, 'Suivi de contact').getByRole('button', { name: /^Appliquer la cadence : S\d{2} \(relance après Contacté\)$/ })).toBeVisible()

  await screenshots(page, 'verified')
})

test('long name, company, role and address wrap inside the drawer on both tabs (no horizontal overflow, 1280 and 1440 px)', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PEL${suffix}`
  const longCompany = `Société de transports routiers internationaux et de logistique ${'multimodale '.repeat(6)}${tag}`
  const longName = `de la Tour-Maubourg-Montmorency-Beaumont${suffix}`
  await importProspects(page, `longs-${suffix}.xlsx`, [
    {
      company: longCompany,
      civility: 'M.',
      first_name: 'Jean-François-Xavier',
      last_name: longName,
      job: `Directeur adjoint des opérations transverses ${'et du développement '.repeat(6)}(synthétique)`,
      email: `${'prenom.nom.tres.long.'.repeat(4)}${tag.toLowerCase()}@exemple.example`,
    },
  ])
  await searchTag(page, tag)
  await people(page).getByRole('link', { name: new RegExp(longName) }).click()
  await expect(page).toHaveURL(/prospect=/)
  const editor = page.getByRole('dialog').first()
  await expect(region(editor, 'Résumé du profil')).toContainText(longName)
  await expect(region(editor, 'Entreprise')).not.toContainText('Chargement')

  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height })
    await expectNoOverflow(page, editor, width, { wholePage: false })
    for (const name of ['Identité', 'E-mails', 'Téléphones', 'Emploi']) {
      const edit = region(editor, name).getByRole('button', { name: `Modifier : ${name}` })
      if (await edit.isVisible()) await edit.click()
    }
    await expectNoOverflow(page, editor, width, { wholePage: false })
    await showTab(editor, 'Suivi')
    await expectNoOverflow(page, editor, width, { wholePage: false })
    await showTab(editor, 'Profil')
  }
})

test('score: a note with an impact changes the score, its detail lists it and leads back to the note (dark/light, 1440 and 1280 px)', async ({ page }) => {
  test.setTimeout(90_000)
  const suffix = uniqueSuffix()
  const tag = `PES${suffix}`
  await importProspects(page, `score-${suffix}.xlsx`, [
    { company: `Transports ${tag}`, civility: 'M.', first_name: 'Léa', last_name: `Score${suffix}`, email: `lea@${tag.toLowerCase()}.example` },
  ])
  await searchTag(page, tag)
  await people(page).getByRole('link', { name: `Léa Score${suffix}` }).click()
  const editor = page.getByRole('dialog', { name: `M. Léa Score${suffix}` })
  const scoreCard = editor.getByRole('button', { name: /^Score prospect/ })

  // No signal yet: the starting score, in words as well as in figures.
  await expect(scoreCard).toContainText('50')
  await expect(scoreCard).toContainText('Moyen')
  await scoreCard.click()
  const detail = page.getByRole('dialog', { name: 'Détail du score' })
  await expect(detail).toContainText('Aucun signal enregistré')
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
  await expect(editor).toBeVisible()
  await expect(scoreCard).toBeFocused()

  // A note with an impact: the score follows (the backend computes it), without saving the prospect.
  await showTab(editor, 'Suivi')
  const notes = region(editor, 'Notes')
  await notes.getByRole('textbox', { name: 'Nouveau fait' }).fill('A demandé une démonstration')
  await notes.getByRole('button', { name: 'Impact sur le score…' }).click()
  await notes.getByRole('textbox', { name: 'Impact sur le score' }).fill('25')
  await notes.getByRole('button', { name: 'Ajouter' }).click()
  await expect(notes.getByRole('img', { name: 'Impact sur le score : +25' })).toBeVisible()
  await showTab(editor, 'Profil')
  await expect(scoreCard).toContainText('75')
  await expect(scoreCard).toContainText('Élevé')

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((value) => {
      window.localStorage.setItem('viper.theme', value)
    }, theme)
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height })
      await page.reload()
      const opened = page.getByRole('dialog').first()
      await expect(opened.getByRole('button', { name: /^Score prospect/ })).toContainText('75')
      await page.mouse.move(0, 0)
      await region(opened, 'Score prospect').screenshot({ path: `${SCREENSHOTS}/prospect-score-card-${theme}-${String(width)}.png`, animations: 'disabled' })
      await expectNoOverflow(page, opened, width)
      await opened.getByRole('button', { name: /^Score prospect/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Détail du score' })
      await expect(dialog).toContainText('A demandé une démonstration')
      await expect(dialog.getByRole('img', { name: '+25 points' })).toBeVisible()
      await page.screenshot({ path: `${SCREENSHOTS}/prospect-score-detail-${theme}-${String(width)}.png`, animations: 'disabled' })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
  }

  // From the detail to the note it comes from.
  await page.getByRole('dialog').first().getByRole('button', { name: /^Score prospect/ }).click()
  await page.getByRole('dialog', { name: 'Détail du score' }).getByRole('button', { name: 'Voir la note' }).click()
  const opened = page.getByRole('dialog').first()
  await expect(opened.getByRole('tab', { name: /^Suivi/ })).toHaveAttribute('aria-selected', 'true')
  const row = region(opened, 'Notes').getByRole('listitem').filter({ hasText: 'A demandé une démonstration' })
  await expect(row).toBeFocused()
  await expect(row).toHaveAttribute('data-highlight', '')
})
