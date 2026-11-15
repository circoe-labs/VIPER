import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'
import type { Warehouse } from '../api/warehouses'

const ROW: Warehouse = { id: '00000000-0000-7000-a000-000000000001', version: '2026-11-03T10:00:00+00:00', name: 'Entrepôt Exemple', owner_name: 'Propriétaire Test', owner_role: 'Foncière', owner_email: null, owner_linkedin: null, address: null, city: 'Lyon', postal_code: null, siret: null, notes: null, source_reference: 'synthetic.xlsx · Sites', status: 'incomplete', missing: ['company'], company_id: null, company_name: null, building_name: null, contacts: [{ full_name: 'Anne Test', role: 'Responsable', email: 'anne@exemple.test ou a.test@exemple.test', linkedin: 'https://www.linkedin.com/in/test-anne' }] }
const API = { ...SHELL_API, 'GET /api/warehouses/counts': [200, { warehouses: 1, contacts: 1, to_contact: 0 }] } as const

describe('Warehouse directory', () => {
  it('filters warehouses by prospecting category through the quick filters and chips', async () => {
    let category = ''
    stubApi({ ...API, 'GET /api/warehouses': (url) => { category = url.searchParams.get('category') ?? ''; return [200, { items: [ROW], total: 1 }] } })
    renderApp('/prospection?entity=warehouse')
    await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
    const quick = within(screen.getByRole('group', { name: 'Filtres rapides' }))
    await userEvent.click(quick.getByRole('button', { name: 'PME/TPE' }))
    await waitFor(() => expect(category).toBe('sme'))
    await userEvent.click(quick.getByRole('button', { name: 'Autres' }))
    await waitFor(() => expect(category).toBe('other'))
    await userEvent.click(quick.getByRole('button', { name: 'À classer' }))
    await waitFor(() => expect(category).toBe('unclassified'))
    expect(quick.getByRole('button', { name: 'À classer' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Retirer le filtre : Catégorie : À classer' }))
    await waitFor(() => expect(category).toBe(''))
  })
  it('refreshes the recipient of an unedited open draft without losing later edits', async () => {
    const draft = { id: 'draft-1', phase: 2, prospecting_category: 'sme', warehouse_name: 'Site', contact_name: 'Anne Test', contact_role: null, source_email: 'anne@example.test', recipient: null, subject: 'Objet', body: '', review_note: 'À vérifier', revision: 1, validated_at: null, validated_by: null, send_state: null, scheduled_at: null }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, [draft]], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: false }] })
    const { queryClient } = renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (1)' }))
    await userEvent.click(await screen.findByText('Anne Test'))
    const recipient = screen.getByLabelText('Destinataire')
    expect(recipient).toHaveValue('')
    act(() => { queryClient.setQueryData(['warehouses', 'drafts'], [{ ...draft, recipient: 'anne@example.test', revision: 2 }]) })
    await waitFor(() => expect(recipient).toHaveValue('anne@example.test'))
    await userEvent.clear(recipient)
    await userEvent.type(recipient, 'autre@example.test')
    act(() => { queryClient.setQueryData(['warehouses', 'drafts'], [{ ...draft, recipient: 'anne@example.test', revision: 3 }]) })
    expect(recipient).toHaveValue('autre@example.test')
  })
  it('separates drafts by warehouse category regardless of phase', async () => {
    const base = { warehouse_name: 'Entrepôt Exemple', contact_role: null, source_email: null, recipient: null, subject: 'Objet', body: '', review_note: 'À vérifier', revision: 1, validated_at: null, validated_by: null, send_state: null, scheduled_at: null }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, [{ ...base, id: 'old', phase: 1, prospecting_category: 'sme', contact_name: 'Ancien Contact' }, { ...base, id: 'new', phase: 2, prospecting_category: 'other', contact_name: 'Nouveau Contact' }]], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: false }] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (1)' }))
    expect(await screen.findByText('Ancien Contact')).toBeVisible()
    expect(screen.queryByText('Nouveau Contact')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons Autres entreprises (1)' }))
    expect(await screen.findByText('Nouveau Contact')).toBeVisible()
    expect(screen.queryByText('Ancien Contact')).not.toBeInTheDocument()
  })
  it('navigates between drafts and keeps unsaved edits when returning', async () => {
    const base = { prospecting_category: 'sme', warehouse_name: 'Entrepôt Exemple', contact_role: 'Responsable', source_email: 'a@example.test', recipient: 'a@example.test', subject: 'Objet', body: 'Bonjour', review_note: 'À vérifier', revision: 1, validated_at: null, validated_by: null, send_state: null, scheduled_at: null }
    const items = [{ ...base, id: 'one', contact_name: 'Anne Test' }, { ...base, id: 'two', contact_name: 'Bruno Test' }]
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, items], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: true }] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (2)' }))
    const anne = await screen.findByText('Anne Test')
    await userEvent.click(anne)
    const firstCard = anne.closest('details')!
    const secondCard = screen.getByText('Bruno Test').closest('details')!
    await userEvent.type(within(firstCard).getByLabelText('Message'), ' modifié')
    expect(within(firstCard).getByRole('button', { name: 'Brouillon précédent' })).toBeDisabled()
    await userEvent.click(within(firstCard).getByRole('button', { name: 'Brouillon suivant' }))
    expect(secondCard).toHaveAttribute('open')
    expect(within(secondCard).getByRole('button', { name: 'Brouillon suivant' })).toBeDisabled()
    expect(within(secondCard).getByText('2 / 2')).toBeVisible()
    await userEvent.click(within(secondCard).getByRole('button', { name: 'Brouillon précédent' }))
    expect(firstCard).toHaveAttribute('open')
    expect(within(firstCard).getByLabelText('Message')).toHaveValue('Bonjour modifié')
  })
  it('opens the next reviewable message only after validation succeeds', async () => {
    const base = { prospecting_category: 'sme', warehouse_name: 'Site', contact_role: null, source_email: 'a@example.test', recipient: 'a@example.test', subject: 'Objet', body: 'Bonjour', review_note: '', revision: 1, validated_at: null, validated_by: null, send_state: 'planned', scheduled_at: '2099-05-01T10:30:00Z' }
    const items = [{ ...base, id: 'one', contact_name: 'Anne Test' }, { ...base, id: 'sent', contact_name: 'Message envoyé', send_state: 'sent' }, { ...base, id: 'two', contact_name: 'Bruno Test' }]
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, items], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: true }], 'POST /api/warehouses/drafts/one/validate': [200, { ...items[0], revision: 2, validated_at: '2026-11-12T10:00:00Z' }], 'POST /api/warehouses/drafts/two/validate': [500, {}] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (3)' }))
    const anne = await screen.findByText('Anne Test')
    const firstCard = anne.closest('details')!
    const nextCard = screen.getByText('Bruno Test').closest('details')!
    const nextSummary = nextCard.querySelector('summary')!
    const scroll = vi.fn(() => { expect(nextCard).toHaveAttribute('open') })
    Object.defineProperty(nextSummary, 'scrollIntoView', { value: scroll, configurable: true })
    await userEvent.click(anne)
    await userEvent.click(within(firstCard).getByRole('button', { name: 'Valid\u00e9 et continuer' }))
    await waitFor(() => expect(nextCard).toHaveAttribute('open'))
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' }))
    expect(firstCard).not.toHaveAttribute('open')
    await userEvent.click(within(nextCard).getByRole('button', { name: 'Valid\u00e9 et continuer' }))
    expect(await within(nextCard).findByRole('alert')).toHaveTextContent('Validation impossible')
    expect(nextCard).toHaveAttribute('open')
  })
  it('schedules the eligible drafts together after confirmation', async () => {
    const draft = { id: 'draft-1', prospecting_category: 'sme', warehouse_name: 'Entrepôt Exemple', contact_name: 'Anne Test', contact_role: 'Responsable', source_email: 'a@example.test', recipient: 'a@example.test', subject: 'Prise de contact', body: 'Bonjour', review_note: 'À vérifier', revision: 1, validated_at: null, validated_by: null, send_state: null, scheduled_at: null }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, [draft]], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: true }], 'POST /api/warehouses/drafts/plan-batch': [200, { scheduled: 1 }] })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (1)' }))
    await userEvent.click(await screen.findByText('Anne Test'))
    expect(screen.queryByLabelText('Date et heure d’envoi')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Date et heure pour tous les messages'), '2099-05-01T10:30')
    await userEvent.click(screen.getByRole('button', { name: 'Pr\u00e9programmer tous les messages' }))
    expect(await screen.findByText('1 messages préprogrammés. Validez chaque message pour autoriser son envoi.')).toBeVisible()
    confirm.mockRestore()
  })
  it('allows editing a scheduled draft without removing its schedule', async () => {
    const draft = { id: 'draft-1', phase: 2, prospecting_category: 'sme', warehouse_name: 'Site', contact_name: 'Anne Test', contact_role: null, source_email: 'a@example.test', recipient: 'a@example.test', subject: 'Objet', body: 'Bonjour', review_note: 'À vérifier', revision: 1, validated_at: '2026-11-12T10:00:00Z', validated_by: 'Lucie', human_validated: true, send_state: 'scheduled', scheduled_at: '2099-05-01T10:30:00Z' }
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, [draft]], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: true }], 'PUT /api/warehouses/drafts/draft-1': [200, { ...draft, revision: 2, body: 'Bonjour modifié' }] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (1)' }))
    const scheduledDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(draft.scheduled_at))
    expect(screen.getByText('1 message programmé').parentElement).toHaveTextContent(`pour le ${scheduledDate}`)
    expect(screen.getByText(/1 messages des deux cat\u00e9gories disponibles/)).toBeVisible()
    const at = new Date(draft.scheduled_at)
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(screen.getByLabelText('Date et heure pour tous les messages')).toHaveValue(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`)
    expect(screen.getByText('Anne Test').closest('details')).toHaveClass('warehouse-draft--confirmed')
    await userEvent.click(await screen.findByText('Anne Test'))
    const message = screen.getByLabelText('Message')
    expect(message).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Valid\u00e9 et continuer' })).toBeEnabled()
    await userEvent.type(message, ' modifié')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('Une modification enregistrée remettra ce message en attente de validation.')).toBeVisible()
  })
  it('distinguishes human review from batch scheduling', async () => {
    const base = { phase: 2, prospecting_category: 'sme', warehouse_name: 'Site', contact_role: null, source_email: 'a@example.test', recipient: 'a@example.test', subject: 'Objet', body: 'Bonjour', review_note: '', revision: 1, validated_at: '2026-11-12T10:00:00Z', validated_by: 'Lucie', send_state: 'scheduled', scheduled_at: '2099-05-01T10:30:00Z' }
    const items = [{ ...base, id: 'one', contact_name: 'Jenny', human_validated: true }, { ...base, id: 'two', contact_name: 'Autre prospect', human_validated: false }]
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, items], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: true }] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (2)' }))
    const reviewed = screen.getByText('Jenny').closest('details')!
    const pending = screen.getByText('Autre prospect').closest('details')!
    expect(reviewed).toHaveClass('warehouse-draft--confirmed')
    expect(within(reviewed).getByText('Validé manuellement · Programmé')).toBeVisible()
    expect(pending).not.toHaveClass('warehouse-draft--confirmed')
    expect(within(pending).getByText('À valider · Programmé')).toBeVisible()
  })
  it('opens the first unreviewed message for a date and stays within that date', async () => {
    const base = { phase: 2, prospecting_category: 'other', warehouse_name: 'Site', contact_role: null, source_email: 'a@example.test', recipient: 'a@example.test', subject: 'Objet', body: 'Bonjour', review_note: '', revision: 1, validated_at: '2026-11-12T10:00:00Z', validated_by: 'Lucie', send_state: 'scheduled' }
    const firstDate = '2099-05-01T10:30:00Z'
    const secondDate = '2099-05-02T10:30:00Z'
    const items = [
      { ...base, id: 'reviewed', contact_name: 'Déjà vérifié', human_validated: true, scheduled_at: secondDate },
      { ...base, id: 'one', contact_name: 'Premier prospect', human_validated: false, scheduled_at: secondDate },
      { ...base, id: 'other', contact_name: 'Autre date', human_validated: false, scheduled_at: firstDate },
      { ...base, id: 'two', contact_name: 'Deuxième prospect', human_validated: false, scheduled_at: secondDate },
    ]
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, items], 'GET /api/warehouses/drafts/dispatch-status': [200, { active: true }], 'POST /api/warehouses/drafts/one/validate': [200, { ...items[1], revision: 2, human_validated: true }] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons Autres entreprises (4)' }))
    const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(secondDate))
    await userEvent.click(screen.getByRole('button', { name: `Voir les messages du ${date}` }))
    expect(screen.getByRole('heading', { name: `Brouillons du ${date} (3)` })).toBeVisible()
    expect(screen.queryByText('Autre date')).not.toBeInTheDocument()
    const first = screen.getByText('Premier prospect').closest('details')!
    const second = screen.getByText('Deuxième prospect').closest('details')!
    expect(first).toHaveAttribute('open')
    await userEvent.click(within(first).getByRole('button', { name: 'Valid\u00e9 et continuer' }))
    await waitFor(() => expect(second).toHaveAttribute('open'))
    expect(screen.queryByText('Autre date')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retour aux sous-brouillons' }))
    expect(screen.getByText('Autre date')).toBeVisible()
  })
  it('shows simulated drafts for human review in their own category', async () => {
    stubApi({ ...API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }], 'GET /api/warehouses/drafts': [200, [{ id: 'draft-1', prospecting_category: 'sme', warehouse_name: 'Entrepôt Exemple', contact_name: 'Anne Test', contact_role: 'Responsable', source_email: 'a@example.test ou b@example.test', recipient: null, subject: 'Prise de contact', body: 'Bonjour', review_note: 'Adresse à vérifier' }]] })
    renderApp('/prospection/warehouse-drafts')
    await userEvent.click(await screen.findByRole('button', { name: 'Brouillons PME/TPE (1)' }))
    expect(await screen.findByRole('heading', { name: 'Brouillons à vérifier (1)' })).toBeVisible()
    await userEvent.click(screen.getByText('Anne Test'))
    expect(screen.getByText('Destinataire à choisir')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'b@example.test' }))
    expect(screen.getByLabelText('Destinataire')).toHaveValue('b@example.test')
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled()
    expect(screen.getByText('Bonjour')).toBeVisible()
    expect(screen.queryByRole('button', { name: /envoyer/i })).not.toBeInTheDocument()
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
    await userEvent.click(within(screen.getByRole('group', { name: 'Filtres rapides' })).getByRole('button', { name: 'À contacter' }))
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
