import { type KeyboardEvent, useRef, useState } from 'react'

import { ApiError } from '../api/client'
import { runSql, type SqlError, sqlError, type SqlResult } from '../api/explorer'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { AlertIcon, InfoIcon, TerminalIcon } from '../ui/icons'
import { clipboardValue } from './cells'

const COUNT = new Intl.NumberFormat('fr-FR')
// PostgreSQL type names (as psql shows them) rendered right-aligned.
const NUMERIC_TYPES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money', 'oid'])

interface SqlConsoleProps {
  // Kept by the page, so closing and reopening the console keeps the query.
  text: string
  onTextChange: (text: string) => void
  onClose: () => void
}

type Outcome = { kind: 'result'; result: SqlResult } | { kind: 'error'; error: SqlError } | null

const UNREACHABLE: SqlError = {
  code: 'unreachable',
  message: 'Le serveur n’a pas répondu : vérifiez la connexion à l’API puis réessayez.',
  detail: null,
  position: null,
}

// Discreet, read-only SQL console (Task 13): one query, Ctrl+Entrée to run, result or error below. The server enforces
// read-only access through a dedicated database role (ADR-0011); nothing here is a security check.
export function SqlConsole({ text, onTextChange, onClose }: SqlConsoleProps) {
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [running, setRunning] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  async function execute() {
    if (running) return
    setRunning(true)
    try {
      setOutcome({ kind: 'result', result: await runSql(text) })
    } catch (caught) {
      const error = (caught instanceof ApiError ? sqlError(caught.detail) : null) ?? UNREACHABLE
      setOutcome({ kind: 'error', error })
      const editor = editorRef.current
      if (editor && error.position !== null) {
        editor.focus()
        editor.setSelectionRange(error.position - 1, error.position)
      }
    } finally {
      setRunning(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void execute()
    }
  }

  return (
    <Drawer
      open
      size="xl"
      title="Console SQL"
      description="Lecture seule, sur les tables exposées de l’explorateur. Résultat et durée plafonnés."
      initialFocusRef={editorRef}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      }
    >
      <div className="sql-console">
        <label className="sql-console__label" htmlFor="sql-console-query">
          Requête
        </label>
        <textarea
          ref={editorRef}
          id="sql-console-query"
          className="sql-console__editor"
          spellCheck={false}
          rows={6}
          placeholder="SELECT display_name, siren FROM companies ORDER BY display_name LIMIT 50"
          aria-describedby="sql-console-hint"
          value={text}
          onChange={(event) => {
            onTextChange(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="sql-console__bar">
          <p id="sql-console-hint" className="sql-console__hint">
            <InfoIcon size={14} /> SELECT, WITH, VALUES, TABLE ou EXPLAIN · une instruction · Ctrl+Entrée pour exécuter
          </p>
          <Button
            variant="primary"
            icon={TerminalIcon}
            loading={running}
            disabled={text.trim() === ''}
            onClick={() => {
              void execute()
            }}
          >
            Exécuter
          </Button>
        </div>
        {outcome?.kind === 'error' && <SqlErrorBox error={outcome.error} />}
        {outcome?.kind === 'result' && <SqlResultView result={outcome.result} />}
      </div>
    </Drawer>
  )
}

function SqlErrorBox({ error }: { error: SqlError }) {
  return (
    <div className="sql-console__error" role="alert">
      <p className="sql-console__error-title">
        <AlertIcon size={16} /> {error.message}
      </p>
      {error.detail && (
        <p className="sql-console__error-detail">
          PostgreSQL : <code>{error.detail}</code>
        </p>
      )}
    </div>
  )
}

function SqlResultView({ result }: { result: SqlResult }) {
  const cut = new Set(result.truncated_cells.map(([row, column]) => `${String(row)}:${String(column)}`))
  const summary = `${COUNT.format(result.row_count)} ligne${result.row_count > 1 ? 's' : ''} · ${COUNT.format(result.duration_ms)} ms`
  return (
    <section className="sql-result" aria-label="Résultat de la requête">
      <p className="sql-result__status" role="status">
        {summary}
        {result.truncated && (
          <span className="sql-result__truncated">
            <AlertIcon size={14} /> Résultat tronqué : seules les {COUNT.format(result.max_rows)} premières lignes sont
            affichées.
          </span>
        )}
      </p>
      {result.columns.length === 0 ? (
        <p className="sql-result__empty">La requête n’a renvoyé aucune colonne.</p>
      ) : (
        <div className="sql-result__scroll">
          <table className="sql-result__table">
            <thead>
              <tr>
                <th scope="col" className="sql-result__number">
                  <span className="visually-hidden">Numéro de ligne</span>#
                </th>
                {result.columns.map((column, index) => (
                  <th key={`${column.name}-${String(index)}`} scope="col">
                    <span className="sql-result__name">{column.name}</span>
                    <span className="sql-result__type">{column.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th scope="row" className="sql-result__number">
                    {rowIndex + 1}
                  </th>
                  {row.map((value, columnIndex) => {
                    const truncated = cut.has(`${String(rowIndex)}:${String(columnIndex)}`)
                    const text = clipboardValue(value)
                    const numeric = NUMERIC_TYPES.has(result.columns[columnIndex]?.type ?? '')
                    return (
                      <td
                        key={columnIndex}
                        className={numeric ? 'sql-result__numeric' : undefined}
                        title={text.length > 40 ? text : undefined}
                      >
                        {value === null ? <span className="cell__null">NULL</span> : text}
                        {truncated && <span title="Valeur tronquée par le serveur">…</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.row_count === 0 && result.columns.length > 0 && <p className="sql-result__empty">Aucune ligne.</p>}
    </section>
  )
}
