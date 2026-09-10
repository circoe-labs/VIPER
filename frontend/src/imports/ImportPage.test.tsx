import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ImportDecisions, PreviewOptions } from '../api/imports'
import { BLOCKED_ID, batch, commitResult, samplePreview } from '../test/importFixtures'
import { renderApp } from '../test/render'

const FILE = new File(['contenu synthétique'], 'base_synthetique.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

interface Sent {
  path: string
  part: unknown
  file: File | null
}

// Stand-in for /api/imports (and the Settings lists the pickers read). Records the multipart parts it receives.
function stubImports({ preview = samplePreview(), commit = json(200, commitResult()) } = {}) {
  const sent: Sent[] = []
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const body = init?.body
    if (body instanceof FormData) {
      const part = body.get('options') ?? body.get('decisions')
      const file = body.get('file')
      sent.push({
        path: url.pathname,
        part: typeof part === 'string' ? JSON.parse(part) : null,
        file: file instanceof File ? file : null,
      })
    }
    if (url.pathname === '/api/imports/preview') return json(200, preview)
    if (url.pathname === '/api/imports/commit') return commit
    if (url.pathname === '/api/imports') return json(200, [])
    if (url.pathname.startsWith('/api/settings/')) return json(200, [])
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return sent
}

async function uploadAndConfirm() {
  await userEvent.upload(screen.getByLabelText('Fichier à importer'), FILE)
  await userEvent.click(await screen.findByRole('button', { name: 'Confirmer la feuille' }))
}

describe('Excel import page', () => {
  it('is a sub-page of Prospection, reachable from its header', async () => {
    stubImports()
    renderApp('/prospection')

    await userEvent.click(screen.getByRole('link', { name: 'Importer Excel' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Importer un fichier Excel' })).toBeInTheDocument()
    const navigation = screen.getByRole('navigation', { name: 'Navigation principale' })
    expect(within(navigation).getByRole('link', { name: 'Prospection' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('Aucun import pour l’instant.')).toBeInTheDocument()
  })

  it('analyses the file, shows the detected and skipped sheets, then the review summary', async () => {
    const sent = stubImports()
    renderApp('/prospection/import')

    await userEvent.upload(screen.getByLabelText('Fichier à importer'), FILE)

    expect(await screen.findByText(/Feuille des prospects détectée/)).toHaveTextContent('« Base client »')
    expect(screen.getByRole('list', { name: 'Feuilles ignorées' })).toHaveTextContent('Feuille « actualité » ignorée')
    expect(sent).toMatchObject([{ path: '/api/imports/preview', part: { mapping: null, corrections: {} } }])
    expect(sent[0]?.file?.name).toBe(FILE.name)
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Feuille')

    await userEvent.click(screen.getByRole('button', { name: 'Confirmer la feuille' }))

    const tiles = screen.getByRole('region', { name: 'Résumé de l’analyse' })
    expect(within(tiles).getByRole('button', { name: /5\s*Lignes/ })).toBeInTheDocument()
    expect(within(tiles).getByRole('button', { name: /2\s*En erreur/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /À résoudre/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Importer…' })).toBeDisabled()
    expect(screen.getByText(/1 ligne en erreur à corriger ou exclure/)).toBeInTheDocument()
  })

  it('shows why a refused file cannot be read and lets the user choose another one', async () => {
    const refusal = {
      detail: {
        code: 'file_rejected',
        message: 'Ancien format Excel 97-2003 (.xls) non pris en charge : enregistrez le fichier en .xlsx.',
        diagnostic: { code: 'file.legacy_xls', severity: 'error', message: 'Ancien format Excel 97-2003 (.xls) non pris en charge : enregistrez le fichier en .xlsx.' },
      },
    }
    vi.stubGlobal('fetch', vi.fn((input: string) => (input.endsWith('/preview') ? json(422, refusal) : json(200, []))))
    renderApp('/prospection/import')

    await userEvent.upload(screen.getByLabelText('Fichier à importer'), FILE)

    expect(await screen.findByRole('alert')).toHaveTextContent('Ancien format Excel 97-2003')
    expect(screen.getByRole('button', { name: 'Choisir un fichier' })).toBeInTheDocument()
  })

  it('maps a raw job title once for every row of its group and creates the role explicitly', async () => {
    const sent = stubImports()
    renderApp('/prospection/import')
    await uploadAndConfirm()

    const roles = screen.getByRole('region', { name: /Rôles non reconnus/ })
    expect(within(roles).getByText('« Directeur fictif »')).toBeInTheDocument()
    expect(within(roles).getByText(/2 lignes/)).toBeInTheDocument()
    await userEvent.selectOptions(within(roles).getByRole('combobox', { name: 'Rôle pour « Directeur fictif »' }), 'create')
    const label = within(roles).getByRole('textbox', { name: 'Libellé du rôle à créer' })
    await userEvent.clear(label)
    await userEvent.type(label, 'Directeur des opérations')
    await userEvent.tab()

    await userEvent.click(screen.getByRole('button', { name: 'Exclure la ligne 4' }))
    await userEvent.click(screen.getByRole('button', { name: 'Importer…' }))
    const dialog = screen.getByRole('dialog', { name: 'Confirmer l’import' })
    expect(within(dialog).getByRole('list', { name: 'Ce qui sera enregistré' })).toHaveTextContent(
      'Rôles créés : « Directeur des opérations »',
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Importer 3 lignes' }))

    const commit = sent.find((item) => item.path === '/api/imports/commit')
    expect(commit?.file?.name).toBe(FILE.name)
    expect(commit?.part).toMatchObject({
      roles: { 'directeur fictif': { action: 'create', label: 'Directeur des opérations' } },
      rows: { 4: { resolution: { action: 'exclude' } } },
    })
  })

  it('summarises the commit, requires the legal basis, then shows the result', async () => {
    const sent = stubImports()
    renderApp('/prospection/import')
    await uploadAndConfirm()
    await userEvent.click(screen.getByRole('button', { name: 'Exclure les lignes en erreur (1)' }))

    await userEvent.click(screen.getByRole('button', { name: 'Importer…' }))

    const dialog = screen.getByRole('dialog', { name: 'Confirmer l’import' })
    const summary = within(dialog).getByRole('list', { name: 'Ce qui sera enregistré' })
    expect(summary).toHaveTextContent('2 nouveaux prospects')
    expect(summary).toHaveTextContent('1 ligne complétant 1 prospect existant (champs vides uniquement, rien n’est écrasé)')
    expect(summary).toHaveTextContent('1 entreprise créée')
    expect(summary).toHaveTextContent('Semaines sans année : 0 datée(s), 1 laissée(s) sans date')
    expect(summary).toHaveTextContent('2 lignes exclues (non importées)')
    const basis = within(dialog).getByRole('textbox', { name: /Base légale ou contexte de collecte/ })
    expect(basis).toHaveValue('Fichier historique Circoe — prospection B2B')
    await userEvent.clear(basis)
    expect(within(dialog).getByRole('button', { name: 'Importer 3 lignes' })).toBeDisabled()
    await userEvent.type(basis, 'Salon fictif 2026')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Référence de la source/ }), 'Liste fictive')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Importer 3 lignes' }))

    expect(await screen.findByRole('heading', { name: 'Import terminé' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Résultat de l’import' })).toHaveTextContent('2 prospects créés')
    expect(sent.at(-1)?.part).toMatchObject({
      legal_basis_or_collection_context: 'Salon fictif 2026',
      source_reference: 'Liste fictive',
      file_fingerprint: 'a'.repeat(64),
      preview_digest: 'b'.repeat(64),
    })
  })

  it('offers only exclusion or attachment to the blocked prospect for a do-not-contact match', async () => {
    const sent = stubImports()
    renderApp('/prospection/import')
    await uploadAndConfirm()

    const opposition = screen.getByRole('region', { name: /Opposition « Ne pas contacter »/ })
    const choices = within(opposition).getAllByRole('radio')
    expect(choices.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Compléter le prospect existant « Bruno Bloqué » (Logistique Démo SAS) — même adresse e-mail — reste « Ne pas contacter »',
      'Exclure la ligne (ne pas l’importer)',
    ])
    expect(within(opposition).getByRole('radio', { name: /Exclure la ligne/ })).toBeChecked()
    await userEvent.click(within(opposition).getByRole('radio', { name: /Bruno Bloqué/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Exclure la ligne 4' }))
    await userEvent.click(screen.getByRole('button', { name: 'Importer…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Importer 4 lignes' }))

    await screen.findByRole('heading', { name: 'Import terminé' })
    expect(sent.at(-1)?.part).toMatchObject({ rows: { 6: { resolution: { action: 'attach', prospect_id: BLOCKED_ID } } } })
  })

  it('corrects a row by analysing the file again with the typed value', async () => {
    const sent = stubImports()
    renderApp('/prospection/import')
    await uploadAndConfirm()

    await userEvent.click(screen.getByRole('button', { name: 'Corriger la ligne 4' }))

    const form = await screen.findByRole('form', { name: 'Correction de la ligne 4' })
    expect(within(form).getByRole('textbox', { name: 'Entreprise' })).toHaveValue('Messagerie Fictive')
    await userEvent.type(within(form).getByRole('textbox', { name: 'Prénom' }), 'Zoé')
    await userEvent.click(within(form).getByRole('button', { name: 'Appliquer et relancer l’analyse' }))

    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        path: '/api/imports/preview',
        part: { corrections: { 4: { first_name: 'Zoé' } } } satisfies PreviewOptions,
      })
    })
  })

  it('filters the rows from a summary tile or a remark and excludes a row from its detail', async () => {
    const sent = stubImports()
    renderApp('/prospection/import')
    await uploadAndConfirm()

    await userEvent.click(screen.getByRole('button', { name: /Rôle non reconnu\s*2/ }))

    const table = screen.getByRole('table', { name: 'Lignes analysées' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    await userEvent.click(within(table).getByRole('button', { name: 'Détails de la ligne 3' }))
    await userEvent.click(screen.getByRole('button', { name: 'Exclure la ligne' }))
    expect(within(table).getByRole('row', { name: /Prénom3/ })).toHaveTextContent('Exclue')

    await userEvent.click(within(screen.getByRole('region', { name: 'Résumé de l’analyse' })).getByRole('button', { name: /En erreur/ }))
    expect(within(screen.getByRole('table', { name: 'Lignes analysées' })).getAllByRole('row')).toHaveLength(3)
    expect(sent).toHaveLength(1)
  })

  it('warns prominently when the same file was already imported and asks for an acknowledgement', async () => {
    const sent = stubImports({ preview: samplePreview([batch()]) })
    renderApp('/prospection/import')
    await uploadAndConfirm()
    expect(screen.getByRole('alert')).toHaveTextContent('Ce fichier a déjà été importé')
    await userEvent.click(screen.getByRole('button', { name: 'Exclure la ligne 4' }))

    await userEvent.click(screen.getByRole('button', { name: 'Importer…' }))
    const dialog = screen.getByRole('dialog', { name: 'Confirmer l’import' })
    const confirm = within(dialog).getByRole('button', { name: 'Importer 3 lignes' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /je confirme vouloir l’importer à nouveau/ }))
    await userEvent.click(confirm)

    await screen.findByRole('heading', { name: 'Import terminé' })
    expect((sent.at(-1)?.part as ImportDecisions).acknowledge_reimport).toBe(true)
  })

  it('explains a stale review and offers to analyse the file again', async () => {
    const stale = json(409, { detail: { code: 'preview_outdated', message: 'Import preview is stale.' } })
    const sent = stubImports({ commit: stale })
    renderApp('/prospection/import')
    await uploadAndConfirm()
    await userEvent.click(screen.getByRole('button', { name: 'Exclure la ligne 4' }))
    await userEvent.click(screen.getByRole('button', { name: 'Importer…' }))
    const dialog = screen.getByRole('dialog', { name: 'Confirmer l’import' })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Importer 3 lignes' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Les données de la base ont changé depuis l’analyse')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Relancer l’analyse' }))
    await waitFor(() => {
      expect(sent.filter((item) => item.path === '/api/imports/preview')).toHaveLength(2)
    })
    expect(sent.at(-1)?.part).toMatchObject({ corrections: {} })
  })
})
