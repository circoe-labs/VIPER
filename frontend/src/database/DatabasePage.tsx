import { useCallback, useMemo, useState } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router'

import { useExplorerTables } from '../api/explorer'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { DatabaseIcon, TerminalIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { type ExplorerView, parseView, serializeView } from './explorerView'
import { readOrigin } from './navigation'
import { SqlConsole } from './SqlConsole'
import { TableRail } from './TableRail'
import { TableWorkspace } from './TableWorkspace'
import './database.css'

// Database Explorer: table rail + data grid (reads: Task 11, staged edits: Task 12) and the read-only SQL console
// (Task 13), opened from the page header.
export function DatabasePage() {
  const { table } = useParams()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tables = useExplorerTables()
  const view = useMemo(() => parseView(searchParams), [searchParams])
  const origin = readOrigin(location.state)
  const locationState: unknown = location.state
  const [sqlOpen, setSqlOpen] = useState(false)
  const [sqlText, setSqlText] = useState('')

  // Grid criteria replace the current history entry (Back returns to the previous table, not the previous
  // keystroke) and keep its state, so "Retour à …" survives filtering after a relationship hop.
  const changeView = useCallback(
    (patch: Partial<ExplorerView>) => {
      setSearchParams((current) => serializeView({ ...parseView(current), ...patch }), {
        replace: true,
        state: locationState,
      })
    },
    [setSearchParams, locationState],
  )

  return (
    <div className="explorer-page">
      <PageHeader
        title="Base de données"
        description="Exploration des tables de VIPER ; les modifications restent en attente jusqu’à « Enregistrer »."
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={TerminalIcon}
            aria-haspopup="dialog"
            onClick={() => {
              setSqlOpen(true)
            }}
          >
            Console SQL
          </Button>
        }
      />
      <div className="explorer">
        <TableRail tables={tables.data} loading={tables.isPending} failed={tables.isError} selected={table} />
        {table ? (
          <TableWorkspace key={table} table={table} view={view} onViewChange={changeView} origin={origin} />
        ) : (
          <section className="explorer-workspace explorer-workspace--center">
            <EmptyState
              icon={DatabaseIcon}
              title="Choisissez une table"
              description="Sélectionnez une table dans la liste pour parcourir ses lignes, ses colonnes et ses relations."
            />
          </section>
        )}
      </div>
      {sqlOpen && (
        <SqlConsole
          text={sqlText}
          onTextChange={setSqlText}
          onClose={() => {
            setSqlOpen(false)
          }}
        />
      )}
    </div>
  )
}
