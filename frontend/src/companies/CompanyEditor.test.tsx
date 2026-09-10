import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { CompanyInput } from '../api/companies'
import type { ProspectSummary } from '../api/companies'
import { company, establishment as establishmentRow, stubCompaniesApi } from '../test/companiesApi'
import { renderApp } from '../test/render'
import { taxonomyValue } from '../test/settingsApi'

// Company editor (Task 07) through the real routes and CompanyEditorProvider, against an in-memory API. Synthetic
// identifiers passing their check digit: SIREN 999 000 011; SIRETs 999 000 011 00018 / 00026 (same SIREN) and
// 999 000 020 00001 (another SIREN).
const SIREN = '999000011'
const SIRET = '99900001100018'
const SIRET_2 = '99900001100026'
const SIRET_OTHER = '99900002000001'

// The editor drawer (a confirmation opened above it comes later in the DOM).
function drawer(): HTMLElement {
  const [first] = screen.getAllByRole('dialog')
  if (!first) throw new Error('No dialog open')
  return first
}

function field(name: string | RegExp, scope: HTMLElement = drawer()) {
  return within(scope).getByRole('textbox', { name })
}

function establishments() {
  return within(drawer()).queryAllByRole('group')
}

function establishment(index: number): HTMLElement {
  const group = establishments()[index]
  if (!group) throw new Error(`No establishment ${String(index)}`)
  return group
}

function confirmation() {
  return screen.getByRole('dialog', { name: 'Abandonner les modifications ?' })
}

function status() {
  return within(drawer()).getByRole('status')
}

async function openNew() {
  await userEvent.click(await screen.findByRole('button', { name: 'Nouvelle entreprise' }))
  return drawer()
}

async function openExisting(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }))
  await waitFor(() => {
    expect(field(/Nom de l’entreprise/)).toHaveValue(name)
  })
}

function lastBody(api: ReturnType<typeof stubCompaniesApi>, method: string): CompanyInput {
  const request = api.requests.filter((item) => item.method === method).at(-1)
  return request?.body as CompanyInput
}

// Long user flows through the whole drawer (the establishments one takes ~5 s on a loaded machine): past Vitest's 5 s
// default a timed-out test keeps typing into the next one's DOM, so give them room instead.
describe('Company editor', { timeout: 15_000 }, () => {
  it('creates a company: the name is required, the payload is normalized, the drawer stays on the saved company', async () => {
    const segment = taxonomyValue('Transporteur')
    const road = taxonomyValue('Transport routier')
    const api = stubCompaniesApi({ segments: [segment], categories: [road, taxonomyValue('Entreposage')] })
    renderApp('/prospection/companies')
    await openNew()
    expect(field(/Nom de l’entreprise/)).toHaveFocus()

    await userEvent.type(field('Raison sociale'), '  Transports   Exemple SAS ')
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Enregistrer' }))

    expect(field(/Nom de l’entreprise/)).toHaveFocus()
    expect(field(/Nom de l’entreprise/)).toHaveAccessibleDescription(expect.stringContaining('Saisissez le nom de l’entreprise.'))
    expect(status()).toHaveTextContent('Corrigez le champ signalé.')
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(0)

    await userEvent.type(field(/Nom de l’entreprise/), 'Transports Exemple')
    await userEvent.type(field('SIREN'), '999 000 011')
    await userEvent.type(within(drawer()).getByRole('combobox', { name: 'Segment commercial' }), 'transp{Enter}')
    await userEvent.type(within(drawer()).getByRole('combobox', { name: 'Catégories d’activité' }), 'routier{Enter}')
    await userEvent.type(field('Approche client'), 'Approche fictive{Enter}sur deux lignes  ')
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => {
      expect(status()).toHaveTextContent('Entreprise enregistrée.')
    })
    expect(lastBody(api, 'POST')).toEqual({
      display_name: 'Transports Exemple',
      legal_name: 'Transports Exemple SAS',
      siren: SIREN,
      website_url: null,
      email_domain: null,
      size_label: null,
      commercial_segment_id: segment.id,
      activity_category_ids: [road.id],
      project_done_with_circoe: null,
      project_type: null,
      circoe_references: null,
      client_approach: 'Approche fictive\nsur deux lignes',
      establishments: [],
    })
    expect(screen.getByRole('dialog', { name: 'Transports Exemple' })).toBeInTheDocument()
    expect(field('SIREN')).toHaveValue('999 000 011')
    expect(within(drawer()).getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(within(drawer()).getByRole('region', { name: 'Prospects associés' })).toHaveTextContent('Aucun prospect')
  })

  it('checks identifiers when a field is left, and only warns about imported ones failing their key', async () => {
    stubCompaniesApi({
      companies: [
        company('Transports Hérités', {
          siren: '000000001',
          establishments: [establishmentRow('Siège', { siret: '00000000000001', is_primary: true })],
        }),
      ],
    })
    renderApp('/prospection/companies')
    await openExisting('Transports Hérités')

    expect(field('SIREN')).toHaveAccessibleDescription(
      expect.stringContaining('Le SIREN enregistré ne respecte pas la clé de contrôle'),
    )
    expect(field('SIREN')).not.toHaveAttribute('aria-invalid')
    await userEvent.type(field('Taille'), '10-49')
    expect(within(drawer()).getByRole('button', { name: 'Enregistrer' })).toBeEnabled()

    await userEvent.clear(field('SIREN'))
    await userEvent.type(field('SIREN'), '12345678')
    await userEvent.tab()
    expect(field('SIREN')).toHaveAccessibleDescription(expect.stringContaining('Le SIREN comporte 9 chiffres.'))
    await userEvent.type(field('SIREN'), '9')
    expect(field('SIREN')).toHaveAccessibleDescription(expect.stringContaining('Ce SIREN n’est pas valide'))
    expect(field('SIREN')).toHaveAttribute('aria-invalid', 'true')
  })

  it('manages establishments: add, primary, remove, SIRET warnings and repeats', async () => {
    const api = stubCompaniesApi()
    renderApp('/prospection/companies')
    await openNew()
    await userEvent.type(field(/Nom de l’entreprise/), 'Transports Exemple')
    await userEvent.type(field('SIREN'), SIREN)
    expect(within(drawer()).getByText(/Aucun établissement/)).toBeInTheDocument()

    const add = within(drawer()).getByRole('button', { name: 'Ajouter un établissement' })
    await userEvent.click(add)
    const head = establishment(0)
    expect(field('Nom de l’établissement', head)).toHaveFocus()
    await userEvent.type(field('Nom de l’établissement', head), 'Siège')
    await userEvent.type(field('SIRET', head), SIRET)
    await userEvent.click(add)
    const depot = establishment(1)
    await userEvent.type(field('Nom de l’établissement', depot), 'Dépôt')
    await userEvent.type(field('SIRET', depot), SIRET_OTHER)
    await userEvent.tab()

    expect(within(head).getByRole('radio', { name: 'Établissement principal' })).toBeChecked()
    expect(within(depot).getByRole('radio', { name: 'Établissement principal' })).not.toBeChecked()
    expect(field('SIRET', depot)).toHaveAccessibleDescription(
      expect.stringContaining('Ce SIRET ne commence pas par le SIREN de l’entreprise (999 000 011)'),
    )
    expect(field('SIRET', depot)).not.toHaveAttribute('aria-invalid')

    await userEvent.clear(field('SIRET', depot))
    await userEvent.type(field('SIRET', depot), SIRET)
    expect(field('SIRET', depot)).toHaveAccessibleDescription(expect.stringContaining('déjà saisi pour un autre établissement'))
    await userEvent.clear(field('SIRET', depot))
    await userEvent.type(field('SIRET', depot), '999 000 011 00026')

    await userEvent.click(within(depot).getByRole('radio', { name: 'Établissement principal' }))
    expect(within(head).getByRole('radio', { name: 'Établissement principal' })).not.toBeChecked()
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Retirer « Dépôt »' }))
    expect(establishments()).toHaveLength(1)
    expect(within(establishment(0)).getByRole('radio', { name: 'Établissement principal' })).toBeChecked()
    expect(add).toHaveFocus()

    await userEvent.click(add)
    await userEvent.type(field('SIRET', establishment(1)), SIRET_2)
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(status()).toHaveTextContent('Entreprise enregistrée.')
    })
    expect(lastBody(api, 'POST').establishments).toEqual([
      expect.objectContaining({ id: null, name: 'Siège', siret: SIRET, is_primary: true }),
      expect.objectContaining({ id: null, name: null, siret: SIRET_2, is_primary: false, country: null }),
    ])
  })

  it('shows the dirty state, reverts, and asks before closing with unsaved changes', async () => {
    const api = stubCompaniesApi({ companies: [company('Transports Exemple', { size_label: '10-49' })] })
    renderApp('/prospection/companies')
    await openExisting('Transports Exemple')
    expect(status()).toBeEmptyDOMElement()

    await userEvent.clear(field('Taille'))
    await userEvent.type(field('Taille'), '50-249')
    expect(status()).toHaveTextContent('Modifications non enregistrées')
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Annuler les modifications' }))
    expect(field('Taille')).toHaveValue('10-49')
    expect(status()).toBeEmptyDOMElement()

    await userEvent.type(field('Taille'), ' salariés')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(within(confirmation()).getByRole('button', { name: 'Continuer la saisie' }))
    expect(field('Taille')).toHaveValue('10-49 salariés')

    await userEvent.click(within(drawer()).getAllByRole('button', { name: 'Fermer' })[0] as HTMLElement)
    await userEvent.click(within(confirmation()).getByRole('button', { name: 'Fermer sans enregistrer' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
  })

  it('saves with Ctrl+S and with Enter in a field', async () => {
    const api = stubCompaniesApi({ companies: [company('Transports Exemple')] })
    renderApp('/prospection/companies')
    await openExisting('Transports Exemple')

    await userEvent.type(field('Taille'), '10-49')
    await userEvent.keyboard('{Control>}s{/Control}')
    await waitFor(() => {
      expect(status()).toHaveTextContent('Entreprise enregistrée.')
    })
    expect(lastBody(api, 'PUT').size_label).toBe('10-49')

    await userEvent.type(field('Raison sociale'), 'Transports Exemple SAS{Enter}')
    await waitFor(() => {
      expect(lastBody(api, 'PUT').legal_name).toBe('Transports Exemple SAS')
    })
    expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(2)
  })

  it('puts a server refusal on its field: a SIREN held by another company names it', async () => {
    stubCompaniesApi({ companies: [company('Logistique Témoin', { siren: SIREN })] })
    renderApp('/prospection/companies')
    await openNew()

    await userEvent.type(field(/Nom de l’entreprise/), 'Doublon')
    await userEvent.type(field('SIREN'), SIREN)
    await userEvent.click(within(drawer()).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => {
      expect(field('SIREN')).toHaveFocus()
    })
    expect(field('SIREN')).toHaveAccessibleDescription(
      expect.stringContaining('Ce SIREN est déjà celui de « Logistique Témoin ».'),
    )
    expect(status()).toHaveTextContent('Enregistrement impossible : Ce SIREN est déjà celui de « Logistique Témoin ».')
  })

  it('maps field refusals of the API to French copy', async () => {
    const api = stubCompaniesApi()
    renderApp('/prospection/companies')
    await openNew()
    await userEvent.type(field(/Nom de l’entreprise/), 'Transports Exemple')
    await userEvent.type(field('Domaine e-mail'), 'gmail.com')
    api.next.reply = [422, { detail: { code: 'invalid', field: 'email_domain', reason: 'webmail', message: 'Webmail.' } }]

    await userEvent.click(within(drawer()).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => {
      expect(field('Domaine e-mail')).toHaveAccessibleDescription(
        expect.stringContaining('messagerie grand public : il ne désigne pas l’entreprise.'),
      )
    })
    await userEvent.type(field('Domaine e-mail'), 'x')
    expect(field('Domaine e-mail')).not.toHaveAttribute('aria-invalid')
  })

  it('lists the associated prospects and refuses to delete a company that has some', async () => {
    const person = { civility: null, role_label: null, exact_job_title: null, contactability_status: 'contactable' } as const
    const prospects: ProspectSummary[] = [
      {
        ...person,
        id: 'p1',
        civility: 'ms',
        first_name: 'Marie',
        last_name: 'Test',
        role_label: 'Dirigeant',
        exact_job_title: 'Gérante',
        activity_status: 'active',
        contactability_status: 'do_not_contact',
      },
      { ...person, id: 'p2', first_name: 'Jean', last_name: 'Exemple', activity_status: 'unknown' },
    ]
    stubCompaniesApi({ companies: [company('Transports Exemple', { prospect_count: 2, prospects })] })
    renderApp('/prospection/companies')
    await openExisting('Transports Exemple')

    const region = within(drawer()).getByRole('region', { name: 'Prospects associés' })
    expect(within(region).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Mme Marie TestDirigeant · GéranteActifNe pas contacter',
      'Jean ExempleRôle non renseignéActivité inconnue',
    ])

    await userEvent.click(within(drawer()).getByRole('button', { name: 'Supprimer' }))
    const refusal = screen.getByRole('dialog', { name: 'Suppression impossible' })
    expect(refusal).toHaveTextContent('« Transports Exemple » est rattachée à 2 prospects.')
    expect(within(refusal).queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
  })

  it('deletes a company without prospects and closes', async () => {
    const api = stubCompaniesApi({ companies: [company('Transports Exemple'), company('Autre Exemple')] })
    renderApp('/prospection/companies')
    await openExisting('Transports Exemple')

    await userEvent.click(within(drawer()).getByRole('button', { name: 'Supprimer' }))
    const confirm = screen.getByRole('dialog', { name: 'Supprimer « Transports Exemple » ?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(api.requests).toContainEqual(expect.objectContaining({ method: 'DELETE' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Transports Exemple' })).not.toBeInTheDocument()
    })
  })

  it('suggests the e-mail domain from the website', async () => {
    stubCompaniesApi()
    renderApp('/prospection/companies')
    await openNew()

    await userEvent.type(field('Site web'), 'https://www.exemple.fr/contact')
    await userEvent.click(within(drawer()).getByRole('button', { name: /Utiliser « exemple.fr »/ }))

    expect(field('Domaine e-mail')).toHaveValue('exemple.fr')
    expect(within(drawer()).queryByRole('button', { name: /Utiliser/ })).not.toBeInTheDocument()
  })

  it('warns about similar companies while a new one is typed and can open one', async () => {
    const existing = company('TRANSPORTS EXEMPLE', { email_domain: 'exemple.fr' })
    stubCompaniesApi({
      companies: [existing],
      similar: [{ ...existing, reasons: ['same_company_name'] }],
    })
    renderApp('/prospection/companies')
    await openNew()

    await userEvent.type(field(/Nom de l’entreprise/), 'Transports Exemple SARL')
    const note = await screen.findByRole('note', { name: 'Entreprises proches déjà enregistrées' })
    expect(note).toHaveTextContent('TRANSPORTS EXEMPLE — même nom · exemple.fr')

    await userEvent.click(within(note).getByRole('button', { name: 'Ouvrir « TRANSPORTS EXEMPLE »' }))
    await userEvent.click(within(confirmation()).getByRole('button', { name: 'Ouvrir sans enregistrer' }))

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'TRANSPORTS EXEMPLE' })).toBeInTheDocument()
    })
  })
})
