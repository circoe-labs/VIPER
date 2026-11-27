import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'
import type { Warehouse } from '../api/warehouses'

const ROW: Warehouse = { id: '00000000-0000-7000-a000-000000000001', version: '2026-11-03T10:00:00+00:00', name: 'Entrepôt Exemple', owner_name: 'Propriétaire Test', owner_role: 'Foncière', owner_email: null, owner_linkedin: null, address: null, city: 'Lyon', postal_code: null, siret: null, notes: null, source_reference: 'synthetic.xlsx · Sites', status: 'incomplete', missing: ['company'], company_id: null, company_name: null, building_name: null, contacts: [{ full_name: 'Anne Test', role: 'Responsable', email: 'anne@exemple.test ou a.test@exemple.test', linkedin: 'https://www.linkedin.com/in/test-anne' }] }
const API = { ...SHELL_API, 'GET /api/warehouses/counts': [200, { warehouses: 1, contacts: 1, to_contact: 0 }], 'GET /api/warehouses/company-proposals': [200, []], 'GET /api/warehouses/00000000-0000-7000-a000-000000000001/people': [200, { company_id: null, company_name: null, people: [] }] } as const

describe('Warehouse directory', () => {
  it('filters warehouses on several prospecting categories, applied by « Valider », and removable chips', async () => {
    let category: string[] = []
    stubApi({ ...API, 'GET /api/warehouses': (url) => { category = url.searchParams.getAll('category'); return [200, { items: [ROW], total: 1 }] } })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
    const categories = within(screen.getByRole('group', { name: 'Catégorie' }))
    await userEvent.click(categories.getByRole('button', { name: 'PME/TPE' }))
    await userEvent.click(categories.getByRole('button', { name: 'À classer' }))
    expect(category).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(category).toEqual(['sme', 'unclassified']) })
    await userEvent.click(screen.getByRole('button', { name: 'Retirer le filtre : Catégorie : À classer' }))
    await waitFor(() => { expect(category).toEqual(['sme']) })
  })
  const MAIL = { id: 'mail-1', warehouse_id: ROW.id, prospect_id: null, warehouse_name: 'Site', contact_name: 'Anne Test', contact_role: null, recipient: 'a@example.test', subject: 'Objet ancien', body: 'Texte ancien', revision: 3, scheduled_at: null, send_state: null, sent_at: null }
  const PERSON = { contact_name: 'Anne Test', kind: 'contact', role: 'Responsable', emails: ['anne@exemple.test'], status: 'new', first_name: 'Anne', last_name: 'Test', civility: null, candidates: [], prospect: null, state: null }

  it('shows the former mails as history, with nothing to write or programme', async () => {
    const mails = [{ ...MAIL, send_state: 'sent', sent_at: '2026-09-01T08:00:00Z' }, { ...MAIL, id: 'mail-2', contact_name: 'Bruno Test', send_state: 'scheduled', scheduled_at: '2099-05-01T10:30:00Z' }, { ...MAIL, id: 'mail-3', contact_name: 'Chloé Test', send_state: 'uncertain', scheduled_at: '2026-09-02T08:00:00Z' }]
    const fetched = stubApi({ ...API, 'GET /api/warehouses/drafts': [200, mails], 'POST /api/warehouses/drafts/mail-3/resolve': [200, { ...mails[2], send_state: 'failed' }] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: /Anne Test/ }))
    expect(screen.getByText('Texte ancien')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Validé|Préprogrammer|Reprogrammer/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retirer la programmation' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Pas parti' }))
    await waitFor(() => { expect(fetched.mock.calls.some(([url, init]) => url.includes('/mail-3/resolve') && (init?.body as string).includes('"sent":false'))).toBe(true) })
  })

  it('makes a listed person a prospect, then opens Contact', async () => {
    const people = { company_id: 'company-1', company_name: 'Société Exemple', people: [PERSON, { ...PERSON, contact_name: 'Accueil', status: 'not_a_person' }] }
    const row = { ...ROW, owner_name: null, contacts: [...ROW.contacts, { full_name: 'Accueil', role: null, email: null, linkedin: null }] }
    const fetched = stubApi({ ...API, 'GET /api/warehouses': [200, { items: [row], total: 1 }], [`GET /api/warehouses/${ROW.id}/people`]: [200, people], 'GET /api/companies/company-1': [404, {}], 'GET /api/companies': [200, { items: [], total: 0 }], [`POST /api/warehouses/${ROW.id}/people`]: [409, { detail: { code: 'person_to_confirm' } }] })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    expect(await screen.findByText('Sans nom de personne')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Contacter Accueil' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Contacter Anne Test' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Contacter Anne Test' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Créer la fiche et contacter' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Une fiche ressemblante existe')
    const posted = fetched.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(posted?.[1]?.body as string).toContain('"company_id":"company-1"')
  })

  const PROPOSAL = { warehouse_id: ROW.id, warehouse_name: 'Zeta Transports - Quai', city: 'Lyon', people: 2, status: 'new', company_id: null, company_name: 'Zeta Transports', sources: ['name'], candidates: [] }

  it('asks to confirm the warehouse’s company before creating a person of a companyless one', async () => {
    const people = { company_id: null, company_name: null, proposal: PROPOSAL, people: [PERSON] }
    const fetched = stubApi({ ...API, 'GET /api/warehouses': [200, { items: [{ ...ROW, owner_name: null }], total: 1 }], [`GET /api/warehouses/${ROW.id}/people`]: [200, people], 'GET /api/companies': [200, { items: [], total: 0 }], [`POST /api/warehouses/${ROW.id}/company`]: [200, { company_id: 'company-9', company_name: 'Zeta Transports', created: true }] })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Contacter Anne Test' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Contacter Anne Test' }))
    expect(dialog.getByText('Zeta Transports · à créer · nom de l’entrepôt')).toBeVisible()
    expect(dialog.getByRole('button', { name: 'Créer la fiche et contacter' })).toBeDisabled()
    expect(fetched.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await userEvent.click(dialog.getByRole('button', { name: 'Rattacher l’entrepôt à cette société' }))
    await waitFor(() => { expect(fetched.mock.calls.some(([, init]) => (init?.body as string | undefined) === '{"new_name":"Zeta Transports"}')).toBe(true) })
  })

  it('attaches only the checked lines of the companyless warehouses, after review', async () => {
    const lines = [PROPOSAL, { ...PROPOSAL, warehouse_id: 'w2', warehouse_name: 'Alpha / Beta', status: 'several', company_name: null, sources: [] }]
    const fetched = stubApi({ ...API, 'GET /api/warehouses/company-proposals': [200, lines], [`POST /api/warehouses/${ROW.id}/company`]: [409, { detail: { code: 'company_ambiguous' } }] })
    renderApp('/prospection/warehouse-companies')
    expect(await screen.findByRole('checkbox', { name: 'Rattacher Alpha / Beta' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Rattacher Zeta Transports - Quai' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Rattacher la sélection (0)' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Cocher les 1 lignes renseignées' }))
    await userEvent.click(screen.getByRole('button', { name: 'Rattacher la sélection (1)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Plusieurs sociétés portent ce nom')
    expect(fetched.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('shows a linked person’s contact state with direct actions, and blocks an opposed one', async () => {
    const state = { block: null, tracking: 'neutral', cohort_code: 'S41', sequence_open: true, sent_count: 1, last_sent_at: '2026-09-01T08:00:00Z', next_scheduled_at: null, warehouse_pending: false, warehouse_uncounted: 0 }
    const linked = { ...PERSON, status: 'linked', prospect: { id: 'prospect-1', first_name: 'Anne', last_name: 'Test', company_name: null }, state }
    const people = { company_id: null, company_name: null, people: [linked] }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [{ ...ROW, owner_name: null }], total: 1 }], [`GET /api/warehouses/${ROW.id}/people`]: [200, people] })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    expect(await screen.findByText(/1 e-mail envoyé/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Contacter Anne Test' })).toHaveAttribute('href', '/contact?prospect=prospect-1')
    expect(screen.getByRole('link', { name: 'Fiche de Anne Test' })).toBeVisible()
  })

  it('places directors first, then logistics managers, and keeps the other contacts in their original order', async () => {
    const contact = (full_name: string, role: string | null) => ({ full_name, role, email: null, linkedin: null })
    const warehouse = { ...ROW, contacts: [
      contact('Autre personne', 'Commercial'),
      contact('Responsable logistique', 'Responsable logistique'),
      contact('Personne sans fonction', null),
      contact('Directrice', 'Directrice du site'),
      contact('Gérant', 'Gérant logistique'),
      contact('Directeur', 'Directeur logistique'),
    ] }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [warehouse], total: 1 }] })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    const list = screen.getByRole('list', { name: 'Interlocuteurs de Entrepôt Exemple' })
    expect(within(list).getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Directrice', 'Directeur', 'Responsable logistique', 'Gérant', 'Autre personne', 'Personne sans fonction',
    ])
  })

  it('lives in Prospection, with compact closed sites and real source contacts on demand', async () => {
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/counts': [200, { warehouses: 51, contacts: 145, to_contact: 0 }] })
    renderApp('/prospection?entity=warehouse')
    const cards = screen.getByRole('navigation', { name: 'Type de fiche' })
    expect(within(cards).getByRole('link', { name: /^Entrepôts/ })).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(within(cards).getByRole('link', { name: /^Entrepôts\s*51/ })).toBeVisible())
    expect(screen.queryByRole('link', { name: /^Entrepôts$/ })).not.toBeInTheDocument()
    const open = await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Anne Test')).not.toBeVisible()
    await userEvent.click(open)
    expect(screen.getByText('Anne Test')).toBeVisible()
    expect(screen.getByText('anne@exemple.test ou a.test@exemple.test')).toBeVisible()
    expect(screen.getAllByText('Propriétaire Test').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Profil LinkedIn' })).toHaveAttribute('href', ROW.contacts[0]?.linkedin)
    await userEvent.click(open)
    expect(screen.getByText('Anne Test')).not.toBeVisible()
  })

  it('saves a contact selection and offers a dedicated category', async () => {
    const selected = { ...ROW, contacts: ROW.contacts.map((contact) => ({ ...contact, to_contact: true })) }
    stubApi({ ...API,
      'GET /api/warehouses': (url) => [200, { items: [url.searchParams.has('to_contact') ? selected : ROW], total: 1 }],
      [`PUT /api/warehouses/${ROW.id}`]: [200, selected],
    })
    const { queryClient } = renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    let submitted: unknown
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.mutation?.state.status === 'success') submitted = event.mutation.state.variables
    })
    await userEvent.click(screen.getByRole('checkbox', { name: 'À contacter prochainement' }))
    expect(submitted).toBeUndefined()
    expect(screen.getByText('Sélection non enregistrée')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Valider la sélection' }))
    await waitFor(() => { expect(submitted).toMatchObject({ id: ROW.id, version: ROW.version, data: { contacts: [{ full_name: 'Anne Test', to_contact: true }] } }) })
    unsubscribe()
    await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
    await userEvent.click(screen.getByRole('switch', { name: 'À contacter' }))
    await userEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    expect(await screen.findByRole('checkbox', { name: 'À contacter prochainement' })).toBeChecked()
  })

  it('groups checked contacts first and validates all changes together', async () => {
    const second = { full_name: 'Bruno Test', role: 'Commercial', email: null, linkedin: null }
    const warehouse = { ...ROW, contacts: [...ROW.contacts, second] }
    const saved = { ...warehouse, contacts: warehouse.contacts.map((contact) => ({ ...contact, to_contact: true })) }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [warehouse], total: 1 }], [`PUT /api/warehouses/${ROW.id}`]: [200, saved] })
    const { queryClient } = renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    const list = screen.getByRole('list', { name: 'Interlocuteurs de Entrepôt Exemple' })
    await userEvent.click(within(within(list).getAllByRole('listitem')[1] as HTMLElement).getByRole('checkbox'))
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Bruno Test')
    await userEvent.click(within(within(list).getAllByRole('listitem')[1] as HTMLElement).getByRole('checkbox'))
    let submitted: unknown
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.mutation?.state.status === 'success') submitted = event.mutation.state.variables
    })
    await userEvent.click(screen.getByRole('button', { name: 'Valider la sélection' }))
    await waitFor(() => { expect(submitted).toMatchObject({ data: { contacts: [{ to_contact: true }, { to_contact: true }] } }) })
    unsubscribe()
  })

  it('shows an honest empty state and creates a site with its interlocutors', async () => {
    let saved: unknown
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [], total: 0 }],
      'POST /api/warehouses': () => [201, ROW] })
    const { queryClient } = renderApp('/prospection?entity=warehouse')
    expect(await screen.findByText('Votre répertoire d’entrepôts')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter le premier entrepôt' }))
    const form = within(screen.getByRole('dialog', { name: 'Ajouter un entrepôt' }))
    await userEvent.type(form.getByRole('textbox', { name: 'Nom de l’entrepôt' }), 'Site Exemple')
    await userEvent.click(form.getByRole('button', { name: 'Ajouter un interlocuteur' }))
    await userEvent.type(form.getByRole('textbox', { name: 'Nom et prénom' }), 'Anne Test')
    await userEvent.type(form.getByRole('textbox', { name: 'E-mail(s) à confirmer' }), 'anne@exemple.test ou a.test@exemple.test')
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.mutation?.state.status === 'success') saved = event.mutation.state.variables
    })
    await userEvent.click(form.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument() })
    unsubscribe()
    expect(saved).toMatchObject({ id: null, data: { name: 'Site Exemple', contacts: [{ full_name: 'Anne Test', email: 'anne@exemple.test ou a.test@exemple.test' }] } })
  })

  it('preserves the read version and contacts when editing an existing site', async () => {
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }],
      [`GET /api/warehouses/${ROW.id}`]: [200, ROW], [`PUT /api/warehouses/${ROW.id}`]: [409, { detail: { code: 'conflict' } }] })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(await screen.findByRole('button', { name: 'Modifier Entrepôt Exemple' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Modifier l’entrepôt' }))
    expect(await dialog.findByRole('textbox', { name: 'Nom de l’entrepôt' })).toHaveValue(ROW.name)
    expect(dialog.getByRole('textbox', { name: 'E-mail(s) à confirmer' })).toHaveValue(ROW.contacts[0]?.email)
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Cette fiche a changé.')
    expect(dialog.getByRole('textbox', { name: 'Nom de l’entrepôt' })).toHaveValue(ROW.name)
  })

  it('reports a list failure rather than showing a false empty directory', async () => {
    stubApi({ ...API, 'GET /api/warehouses': [500, {}] })
    renderApp('/prospection?entity=warehouse')
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les entrepôts.')
    expect(screen.queryByText('Votre répertoire d’entrepôts')).not.toBeInTheDocument()
  })
})

describe('Former Entrepôts page', () => {
  it('redirects /warehouses to the Entrepôts view of Prospection, keeping query and hash', async () => {
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }] })
    const { router } = renderApp('/warehouses?q=lyon#liste')
    expect(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/prospection')
    expect(router.state.location.search).toBe('?q=lyon&entity=warehouse')
    expect(router.state.location.hash).toBe('#liste')
  })
})
