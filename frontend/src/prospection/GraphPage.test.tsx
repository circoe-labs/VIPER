import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderApp, stubApi } from '../test/render'

const person = (kind: 'prospect' | 'member', id: string, name: string, company: string | null) => ({
  kind,
  id,
  name,
  company_id: company,
  company_name: company ? 'Acme' : null,
})
const ana = person('prospect', 'p1', 'Ana Roy', 'c1')
const bob = person('prospect', 'p2', 'Bob Lee', 'c1')
const robin = person('member', 'u1', 'Robin Poté', null)
const GRAPH = {
  members: [robin],
  companies: [{ id: 'c1', name: 'Acme', prospects: [ana, bob] }],
  links: [{ id: 'l1', a: robin, b: ana, relation: 'amis', score: 80, note: null }],
}

Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { value: () => undefined, configurable: true })

Object.defineProperty(SVGElement.prototype, 'getScreenCTM', { value: () => {
    const identity = { a: 1, d: 1, inverse: () => identity }
    return identity
  },
  configurable: true,
})
// jsdom has no DOMPoint: an identity transform is enough for the selection logic.
class FakePoint {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
  matrixTransform() {
    return this
  }
}
Object.defineProperty(globalThis, 'DOMPoint', { value: FakePoint, configurable: true, writable: true })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Graph page', () => {
  it('has no page header, a floating « Retour à la base » and a company rectangle', async () => {
    stubApi({ 'GET /api/links/graph': [200, GRAPH], 'GET /api/links/relations': [200, []] })
    const { container } = renderApp('/prospection/graphe')
    await screen.findByRole('button', { name: /Ana Roy/ })
    expect(screen.getByRole('link', { name: /Retour à la base/ })).toBeInTheDocument()
    expect(container.querySelector('.page-header')).toBeNull()
    expect(container.querySelector('.graph-blob rect')).not.toBeNull()
  })

  it('right click on a prospect offers the fiche, the prospect and the isolation', async () => {
    stubApi({ 'GET /api/links/graph': [200, GRAPH], 'GET /api/links/relations': [200, []] })
    renderApp('/prospection/graphe')
    const node = await screen.findByRole('button', { name: /Ana Roy/ })
    fireEvent.contextMenu(node)
    expect(await screen.findByRole('menuitem', { name: 'Voir la fiche' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Voir le prospect' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /Isoler le prospect/ }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Bob Lee/ })).toBeNull()
    })
    expect(screen.getAllByRole('button', { name: /Robin Poté/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Tout afficher' })).toBeInTheDocument()
  })

  it('shift-click adds to the selection', async () => {
    stubApi({ 'GET /api/links/graph': [200, GRAPH], 'GET /api/links/relations': [200, []] })
    renderApp('/prospection/graphe')
    const ana_ = await screen.findByRole('button', { name: /Ana Roy/ })
    const bob_ = screen.getByRole('button', { name: /Bob Lee/ })
    fireEvent.pointerDown(ana_, { button: 0 })
    fireEvent.pointerDown(bob_, { button: 0, shiftKey: true })
    expect(await screen.findByText('2 sélectionnés')).toBeInTheDocument()
  })
})
