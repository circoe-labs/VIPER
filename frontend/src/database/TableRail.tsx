import { useState } from 'react'
import { Link } from 'react-router'

import type { ExplorerTableSummary } from '../api/explorer'
import { AlertIcon, SearchIcon } from '../ui/icons'
import { viewHref } from './explorerView'
import { groupTables, matchesTable, tableLabel } from './tableCatalog'

interface TableRailProps {
  tables: ExplorerTableSummary[] | undefined
  loading: boolean
  failed: boolean
  selected: string | undefined
}

const COUNT = new Intl.NumberFormat('fr-FR')

// Left rail: the exposed tables, grouped, with a filter box and exact row counts.
export function TableRail({ tables, loading, failed, selected }: TableRailProps) {
  const [query, setQuery] = useState('')
  const visible = (tables ?? []).filter((table) => matchesTable(table.name, query))

  return (
    <nav className="table-rail" aria-label="Tables">
      <div className="table-rail__header">
        <h2 className="table-rail__title">Tables</h2>
        {tables && <span className="table-rail__total">{tables.length}</span>}
      </div>
      <label className="explorer-search table-rail__search">
        <SearchIcon size={16} />
        <span className="visually-hidden">Filtrer les tables</span>
        <input
          type="search"
          placeholder="Filtrer les tables"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
      </label>
      <div className="table-rail__list">
        {loading && <p className="table-rail__note">Chargement des tables…</p>}
        {failed && (
          <p className="table-rail__note table-rail__note--error">
            <AlertIcon size={16} />
            Tables indisponibles
          </p>
        )}
        {tables && visible.length === 0 && <p className="table-rail__note">Aucune table ne correspond.</p>}
        {groupTables(visible).map((group) => (
          <section key={group.label} className="table-rail__group" aria-label={group.label}>
            <h3 className="table-rail__group-title">{group.label}</h3>
            <ul>
              {group.tables.map((table) => (
                <li key={table.name}>
                  <Link
                    to={viewHref(table.name)}
                    className="table-rail__item"
                    aria-current={table.name === selected ? 'page' : undefined}
                  >
                    <span className="table-rail__names">
                      <span className="table-rail__name">{table.name}</span>
                      {tableLabel(table.name) && <span className="table-rail__label">{tableLabel(table.name)}</span>}
                    </span>
                    <span className="table-rail__count">
                      {COUNT.format(table.row_count)}
                      <span className="visually-hidden"> lignes</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  )
}
