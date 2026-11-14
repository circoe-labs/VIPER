import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { parseView as parseContact } from './contact/criteria'
import { HOME_DESTINATIONS, type HomeCardId } from './home/destinations'
import { parseView as parseProspection } from './prospection/criteria'
import { SHELL_API } from './test/homeApi'
import { renderApp, stubApi } from './test/render'

const CONTEXT = { weekStart: '2026-10-26' }
const url = (id: HomeCardId) => new URL(HOME_DESTINATIONS[id](CONTEXT), 'http://localhost')

// Every Home descriptor must be read back by the page it leads to (frozen params, Slice 05).
describe('Home descriptors are understood by their destination page', () => {
  it('Contact cards use `view=`, never the retired `status=`', () => {
    const expected = { appointments: 'appointments', to_contact: 'to_contact', due: 'follow_ups' } as const
    for (const [id, view] of Object.entries(expected)) {
      const target = url(id as HomeCardId)
      expect(target.pathname).toBe('/contact')
      expect(target.searchParams.has('status')).toBe(false)
      expect(parseContact(target.searchParams).view).toBe(view)
    }
  })

  it('Prospection cards select the entity, the creation week and the review', () => {
    const prospects = parseProspection(url('new_prospects').searchParams)
    expect(prospects).toMatchObject({ entity: 'prospect', created_from: '2026-10-26' })
    expect(parseProspection(url('new_companies').searchParams)).toMatchObject({ entity: 'company', created_from: '2026-10-26' })
    expect(parseProspection(url('to_verify').searchParams)).toMatchObject({ entity: 'prospect', review: 'to_verify' })
    // The warehouse list cannot be filtered by creation date: no fake `created_from`.
    expect(url('new_warehouses').search).toBe('?entity=warehouse')
    expect(parseProspection(url('new_warehouses').searchParams).entity).toBe('warehouse')
  })

  it('omits created_from when the week is unknown', () => {
    expect(HOME_DESTINATIONS.new_prospects({ weekStart: undefined })).toBe('/prospection?entity=prospect')
  })
})

describe('bookmarks and legacy paths', () => {
  const api = { ...SHELL_API }

  it('redirects /prospection/companies to the company entity, keeping the query', async () => {
    stubApi(api)
    const { router } = renderApp('/prospection/companies?q=acme&created_from=2026-10-26')
    await screen.findByRole('navigation', { name: 'Type de fiche' })
    expect(router.state.location.pathname).toBe('/prospection')
    const params = new URLSearchParams(router.state.location.search)
    expect(parseProspection(params)).toMatchObject({ entity: 'company', q: 'acme', created_from: '2026-10-26' })
  })

  it('redirects /contacts-joignables to the validated prospect list', async () => {
    stubApi(api)
    const { router } = renderApp('/contacts-joignables?q=acme')
    await screen.findByRole('navigation', { name: 'Type de fiche' })
    expect(parseProspection(new URLSearchParams(router.state.location.search))).toMatchObject({ validated_only: true, q: 'acme' })
  })

  it('redirects /exploitation to /contact keeping the legacy section', () => {
    stubApi(api)
    const { router } = renderApp('/exploitation?section=CONTACTES')
    expect(router.state.location.pathname).toBe('/contact')
    expect(parseContact(new URLSearchParams(router.state.location.search)).view).toBe('contacted')
  })

  it('keeps /contact?section=CONTACTES and /prospection?segment= readable', () => {
    expect(parseContact(new URLSearchParams('section=CONTACTES')).view).toBe('contacted')
    expect(parseProspection(new URLSearchParams('segment=due')).segment).toBe('due')
  })
})

describe('entity switching lives in the URL', () => {
  it('walks Back and Forward through entities', async () => {
    stubApi({ ...SHELL_API })
    const { router } = renderApp('/prospection')
    const nav = await screen.findByRole('navigation', { name: 'Type de fiche' })
    await userEvent.click(within(nav).getByRole('link', { name: /Entrepôts/ }))
    expect(router.state.location.search).toBe('?entity=warehouse')
    await userEvent.click(within(nav).getByRole('link', { name: /Entreprises/ }))
    expect(router.state.location.search).toBe('?entity=company')
    await router.navigate(-1)
    expect(router.state.location.search).toBe('?entity=warehouse')
    await router.navigate(-1)
    expect(router.state.location.search).toBe('')
    await router.navigate(1)
    expect(router.state.location.search).toBe('?entity=warehouse')
  })
})
