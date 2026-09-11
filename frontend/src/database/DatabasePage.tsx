import { useCallback, useMemo, useState } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router'

import { apiRequest } from '../api/client'
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

interface ResetResult {
  prospects_deleted: number
  prospects_preserved_do_not_contact: number
  companies_deleted: number
}

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
  const [resetting, setResetting] = useState(false)

  const changeView = useCallback(
    (patch: Partial<ExplorerView>) => {
      setSearchParams((current) => serializeView({ ...parseView(current), ...patch }), {
        replace: true,
        state: locationState,
      })
    },
    [setSearchParams, locationState],
  )

  const resetProspecting = useCallback(async () => {
    const confirmed = window.confirm(
      'Réinitialiser les données de prospection avant un nouvel import Excel ?\n\nLes oppositions / « à ne plus contacter », l’audit, l’historique des imports et les référentiels seront conservés.',
    )
    if (!confirmed) return
    setResetting(true)
    try {
      const result = await apiRequest<ResetResult>('POST', '/database/reset-prospecting', {
        body: { confirmation: 'RESET_PROSPECTING_DATA' },
      })
      window.alert(
        `Base de prospection réinitialisée : ${String(result.prospects_deleted)} prospect(s) supprimé(s), ${String(result.prospects_preserved_do_not_contact)} opposition(s) conservée(s).`,
      )
      window.location.reload()
    } finally {
      setResetting(false)
    }
  }, [])

  return (
    <div className="explorer-page">
      <PageHeader
        title="Base de données"
        description="Exploration des tables de VIPER ; les modifications restent en attente jusqu’à « Enregistrer »."
        actions={
          <>
            <Button
              variant="danger"
              size="sm"
              loading={resetting}
              onClick={() => void resetProspecting()}
            >
              Réinitialiser la prospection
            </Button>
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
          </>
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
