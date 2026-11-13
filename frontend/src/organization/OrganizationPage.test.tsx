import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Member, OrganizationDetail } from '../api/organizations'
import { renderApp, stubApi, TEST_USER } from '../test/render'

const CIRCOE = TEST_USER.organization.id
const SUMMARY = { id: CIRCOE, name: 'CIRCOE', email_domain: 'circoe.com', members: 2, created_at: '2026-11-03T10:00:00Z' }

function member(overrides: Partial<Member>): Member {
  return {
    id: 'm-1',
    email: 'marie@circoe.com',
    display_name: 'Marie Durand',
    role: 'member',
    is_superadmin: false,
    is_active: true,
    infomaniak_linked: true,
    last_login_at: null,
    can_edit: false,
    can_change_role: false,
    ...overrides,
  }
}

function detail(overrides: Partial<OrganizationDetail>): OrganizationDetail {
  return {
    organization: SUMMARY,
    members: [
      member({ id: TEST_USER.id, email: TEST_USER.email, display_name: 'Pilote Test', role: 'admin' }),
      member({ can_edit: true, can_change_role: true }),
    ],
    assignable_roles: ['admin', 'manager', 'member'],
    can_rename: false,
    ...overrides,
  }
}

describe('OrganizationPage', () => {
  it('lets an admin change a role and add a member', async () => {
    const fetchMock = stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({})],
      [`PATCH /api/organizations/${CIRCOE}/members/m-1`]: [200, member({ role: 'manager' })],
    })
    renderApp('/organisation')

    expect(await screen.findByRole('heading', { level: 1, name: 'Organisation' })).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Membres de l’organisation' })
    expect(within(table).getByText('vous')).toBeInTheDocument()
    // Nobody changes their own role: only Marie has a role picker.
    expect(within(table).getAllByRole('combobox')).toHaveLength(1)
    await userEvent.selectOptions(within(table).getByRole('combobox', { name: 'Rôle de Marie Durand' }), 'manager')

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ role: 'manager' })
    expect(screen.getByRole('button', { name: 'Ajouter un membre' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Désactiver Marie Durand' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Nouvelle organisation' })).not.toBeInTheDocument()
  })

  it('shows a member the list without any action', async () => {
    stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [
        200,
        detail({ assignable_roles: [], members: [member({}), member({ id: 'm-2', display_name: 'Paul' })] }),
      ],
    })
    renderApp('/organisation')

    const table = await screen.findByRole('table', { name: 'Membres de l’organisation' })
    expect(within(table).queryByRole('combobox')).not.toBeInTheDocument()
    // Only the « ⋯ » menu (copy the address); nothing that changes a member.
    expect(within(table).queryByRole('button', { name: /Désactiver|Réactiver/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ajouter un membre' })).not.toBeInTheDocument()
    // The roles explain themselves on hover, not in a paragraph.
    expect(screen.getByRole('button', { name: 'Aide : Manager' })).toBeInTheDocument()
  })

  it('lets the platform admin create an organisation and switch to it', async () => {
    const acme = { ...SUMMARY, id: 'acme', name: 'Acme', email_domain: null, members: 0 }
    const fetchMock = stubApi({
      'GET /api/organizations': [200, { organizations: [acme, SUMMARY], can_create: true }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({ can_rename: true })],
      'GET /api/organizations/acme': [200, detail({ organization: acme, members: [] })],
      'POST /api/organizations': [201, detail({ organization: acme, members: [] })],
    })
    renderApp('/organisation')

    await userEvent.click(await screen.findByRole('button', { name: 'Nouvelle organisation' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom' }), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: 'Créer' }))

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ name: 'Acme', email_domain: null })
    expect(await screen.findByRole('heading', { level: 2, name: 'Acme' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Organisations' })).toBeInTheDocument()
  })

  it('opens a member menu on right click: edit, role, deactivate, delete with confirmation', async () => {
    const fetchMock = stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({})],
      [`DELETE /api/organizations/${CIRCOE}/members/m-1`]: [204, null],
    })
    renderApp('/organisation')

    const table = await screen.findByRole('table', { name: 'Membres de l’organisation' })
    const row = within(table).getByText('Marie Durand').closest('tr')
    if (!row) throw new Error('row')
    fireEvent.contextMenu(row)

    const menu = screen.getByRole('menu', { name: 'Actions pour Marie Durand' })
    for (const name of [
      'Modifier…',
      'Copier l’adresse e-mail',
      'Rôle : Membre',
      'Réinitialiser le mot de passe…',
      'Désactiver',
      'Supprimer…',
    ]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument()
    }
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Supprimer…' }))
    const dialog = screen.getByRole('dialog', { name: 'Supprimer Marie Durand ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }))

    expect(fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && url.endsWith('/members/m-1'))).toBe(
      true,
    )
  })

  async function openMemberMenu() {
    const table = await screen.findByRole('table', { name: 'Membres de l’organisation' })
    const row = within(table).getByText('Marie Durand').closest('tr')
    if (!row) throw new Error('row')
    fireEvent.contextMenu(row)
    return screen.getByRole('menu', { name: 'Actions pour Marie Durand' })
  }

  it('changes the role through one « Rôle » item whose submenu marks the current role', async () => {
    const fetchMock = stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({})],
      [`PATCH /api/organizations/${CIRCOE}/members/m-1`]: [200, member({ role: 'manager' })],
    })
    renderApp('/organisation')
    const menu = await openMemberMenu()

    const parent = within(menu).getByRole('menuitem', { name: 'Rôle : Membre' })
    expect(parent).toHaveAttribute('aria-haspopup', 'menu')
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(parent)
    const sub = screen.getByRole('menu', { name: 'Changer le rôle' })
    expect(within(sub).getByRole('menuitemradio', { name: 'Membre' })).toBeChecked()
    expect(within(sub).getByRole('menuitemradio', { name: 'Manager' })).not.toBeChecked()

    await userEvent.click(within(sub).getByRole('menuitemradio', { name: 'Manager' }))

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ role: 'manager' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('confirms then sends the password reset mail and says so', async () => {
    const fetchMock = stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({})],
      [`POST /api/organizations/${CIRCOE}/members/m-1/password-reset`]: [
        200,
        { sent: true, email: 'marie@circoe.com' },
      ],
    })
    renderApp('/organisation')
    const menu = await openMemberMenu()

    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Réinitialiser le mot de passe…' }))
    const dialog = screen.getByRole('dialog', { name: 'Réinitialiser le mot de passe ?' })
    expect(dialog).toHaveTextContent(
      'Envoyer un e-mail de réinitialisation à marie@circoe.com ? La personne recevra un lien valable 1 h pour choisir un nouveau mot de passe.',
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Envoyer l’e-mail' }))

    const status = await screen.findByText(/E-mail de réinitialisation envoyé à/)
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent('marie@circoe.com')
    expect(fetchMock.mock.calls.some(([url, init]) => init?.method === 'POST' && url.endsWith('/password-reset'))).toBe(
      true,
    )
  })

  it('warns when the reset mail could not leave', async () => {
    stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({})],
      [`POST /api/organizations/${CIRCOE}/members/m-1/password-reset`]: [
        200,
        { sent: false, email: 'marie@circoe.com' },
      ],
    })
    renderApp('/organisation')
    const menu = await openMemberMenu()

    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Réinitialiser le mot de passe…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer l’e-mail' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('L’e-mail n’a pas pu partir (messagerie non connectée)')
  })

  it('shows the 403 reason in the confirmation when the reset is refused', async () => {
    stubApi({
      'GET /api/organizations': [200, { organizations: [SUMMARY], can_create: false }],
      [`GET /api/organizations/${CIRCOE}`]: [200, detail({})],
      [`POST /api/organizations/${CIRCOE}/members/m-1/password-reset`]: [403, { detail: 'forbidden' }],
    })
    renderApp('/organisation')
    const menu = await openMemberMenu()

    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Réinitialiser le mot de passe…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer l’e-mail' }))

    expect(await screen.findByText('Votre rôle ne permet pas cette action.')).toBeInTheDocument()
  })
})
