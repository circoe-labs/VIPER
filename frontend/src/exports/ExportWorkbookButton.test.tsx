import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderApp } from '../test/render'
import { ExportWorkbookButton } from './ExportWorkbookButton'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function workbookResponse(filename: string | null = 'VIPER_export_2026-09-10.xlsx'): Response {
  const headers: Record<string, string> = { 'Content-Type': XLSX }
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`
  return new Response(new Blob(['PK synthétique'], { type: XLSX }), { status: 200, headers })
}

// jsdom has no object URLs (this file's environment only): record what the button hands to the browser instead.
const revokeObjectURL = vi.fn()

function captureSaves() {
  const saved: { name: string; href: string }[] = []
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:export'), revokeObjectURL })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, href: this.getAttribute('href') ?? '' })
  })
  return saved
}

describe('ExportWorkbookButton', () => {
  it('downloads the workbook under the server’s file name, showing progress meanwhile', async () => {
    let reply: (response: Response) => void = () => undefined
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (reply = resolve)))
    vi.stubGlobal('fetch', fetchMock)
    const saved = captureSaves()
    render(<ExportWorkbookButton />)

    await userEvent.click(screen.getByRole('button', { name: 'Exporter Excel' }))

    const busy = screen.getByRole('button', { name: 'Export en cours…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(fetchMock).toHaveBeenCalledWith('/api/exports/workbook', expect.anything())
    reply(workbookResponse())
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Exporter Excel' })).toBeEnabled()
    })
    expect(saved).toEqual([{ name: 'VIPER_export_2026-09-10.xlsx', href: 'blob:export' }])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('names the file itself when the server gives no name', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(workbookResponse(null))))
    const saved = captureSaves()
    render(<ExportWorkbookButton />)

    await userEvent.click(screen.getByRole('button', { name: 'Exporter Excel' }))

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.name).toMatch(/^VIPER_export_\d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it('says in French when the export fails and lets the user try again', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })))
    vi.stubGlobal('fetch', fetchMock)
    const saved = captureSaves()
    render(<ExportWorkbookButton />)

    await userEvent.click(screen.getByRole('button', { name: 'Exporter Excel' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('L’export Excel a échoué. Réessayez.')
    expect(saved).toEqual([])
    fetchMock.mockImplementation(() => Promise.resolve(workbookResponse()))
    await userEvent.click(screen.getByRole('button', { name: 'Exporter Excel' }))
    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['/prospection/companies', 'Entreprises'],
    ['/prospection/import', 'Importer un fichier Excel'],
  ])('is offered in the header of %s', async (path, title) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    )
    renderApp(path)

    const header = (await screen.findByRole('heading', { level: 1, name: title })).closest('header')
    expect(header).not.toBeNull()
    expect(header?.querySelector('.page-header__actions')).toHaveTextContent('Exporter Excel')
  })
})
