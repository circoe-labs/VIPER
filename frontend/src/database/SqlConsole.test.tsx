import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { SqlResult } from '../api/explorer'
import { TABLES } from '../test/explorerFixtures'
import { type ApiReply, renderApp, stubApi } from '../test/render'

const RESULT: SqlResult = {
  columns: [
    { name: 'display_name', type: 'varchar' },
    { name: 'siren', type: 'varchar' },
  ],
  rows: [
    ['Transports Exemple SARL', null],
    ['Logistique Démo SAS', '000000002'],
  ],
  truncated_cells: [],
  row_count: 2,
  truncated: false,
  max_rows: 1000,
  duration_ms: 7,
}

function stub(reply: ApiReply) {
  return stubApi({
    'GET /api/health': [200, { status: 'ok', database: 'ok' }],
    'GET /api/explorer/tables': [200, TABLES],
    'POST /api/explorer/sql': reply,
  })
}

async function openConsole() {
  await userEvent.click(await screen.findByRole('button', { name: 'Console SQL' }))
  const panel = screen.getByRole('dialog', { name: 'Console SQL' })
  const editor = within(panel).getByRole('textbox', { name: 'Requête' })
  return { panel, editor }
}

describe('SQL panel', () => {
  it('runs the query with Ctrl+Enter and shows the rows', async () => {
    const fetchMock = stub([200, RESULT])
    renderApp('/database')
    const { panel, editor } = await openConsole()

    expect(editor).toHaveFocus()
    await userEvent.type(editor, 'SELECT display_name, siren FROM companies{Control>}{Enter}{/Control}')

    const result = await within(panel).findByRole('region', { name: 'Résultat de la requête' })
    expect(within(result).getByRole('status')).toHaveTextContent('2 lignes · 7 ms')
    expect(within(result).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Numéro de ligne#',
      'display_namevarchar',
      'sirenvarchar',
    ])
    expect(within(result).getByRole('cell', { name: 'Logistique Démo SAS' })).toBeInTheDocument()
    expect(within(result).getByText('NULL')).toBeInTheDocument()
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/explorer/sql') ?? []
    expect(JSON.parse(init?.body as string)).toEqual({ sql: 'SELECT display_name, siren FROM companies' })
  })

  it('says when the result was cut at the row limit', async () => {
    stub([200, { ...RESULT, truncated: true, max_rows: 2 }])
    renderApp('/database')
    const { panel, editor } = await openConsole()

    await userEvent.type(editor, 'SELECT * FROM emails')
    await userEvent.click(within(panel).getByRole('button', { name: 'Exécuter' }))

    expect(await within(panel).findByText(/Résultat tronqué : seules les 2 premières lignes/)).toBeInTheDocument()
  })

  it('shows a refusal with the database message and selects the error position', async () => {
    stub([
      422,
      {
        detail: {
          code: 'syntax',
          message: 'Erreur de syntaxe à la position 10.',
          detail: 'syntax error at or near "FORM"',
          position: 10,
        },
      },
    ])
    renderApp('/database')
    const { panel, editor } = await openConsole()

    await userEvent.type(editor, 'SELECT * FORM roles{Control>}{Enter}{/Control}')

    const alert = await within(panel).findByRole('alert')
    expect(alert).toHaveTextContent('Erreur de syntaxe à la position 10.')
    expect(alert).toHaveTextContent('PostgreSQL : syntax error at or near "FORM"')
    expect(editor).toHaveFocus()
    expect([(editor as HTMLTextAreaElement).selectionStart, (editor as HTMLTextAreaElement).selectionEnd]).toEqual([9, 10])
  })

  it('keeps the query when the panel is closed and reopened', async () => {
    stub([200, RESULT])
    renderApp('/database')
    const { panel, editor } = await openConsole()
    await userEvent.type(editor, 'VALUES (1)')

    await userEvent.click(within(panel).getAllByRole('button', { name: 'Fermer' })[0] as HTMLElement)
    expect(screen.queryByRole('dialog', { name: 'Console SQL' })).not.toBeInTheDocument()

    expect((await openConsole()).editor).toHaveValue('VALUES (1)')
  })
})
