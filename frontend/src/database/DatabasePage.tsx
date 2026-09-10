import { useCallback, useMemo } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router'

import { useExplorerTables } from '../api/explorer'
import { EmptyState } from '../ui/EmptyState'
import { DatabaseIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { type ExplorerView, parseView, serializeView } from './explorerView'
import { readOrigin } from './navigation'
import { TableRail } from './TableRail'
import { TableWorkspace } from './TableWorkspace'
import './database.css'

// Database Explorer (read-only, Task 11): table rail + data grid. Writes arrive with Task 12, SQL with Task 13.
export function DatabasePage() {
  const { table } = useParams()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tables = useExplorerTables()
  const view = useMemo(() => parseView(searchParams), [searchParams])
  const origin = readOrigin(location.state)
  const locationState: unknown = location.state

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
      <PageHeader title="Base de données" description="Exploration en lecture seule des tables de VIPER." />
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
    </div>
  )
}
