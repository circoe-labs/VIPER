import { Link } from 'react-router'

import type { ExplorerTable } from '../api/explorer'
import { Badge } from '../ui/Badge'
import { Drawer } from '../ui/Dialog'
import { Table } from '../ui/Table'
import { viewHref } from './explorerView'
import { tableLabel } from './tableCatalog'

interface TableStructureProps {
  meta: ExplorerTable
  onClose: () => void
}

const COUNT = new Intl.NumberFormat('fr-FR')

// Column metadata panel: types, nullability, defaults, keys, allowed values, and the tables referencing this one.
export function TableStructure({ meta, onClose }: TableStructureProps) {
  const label = tableLabel(meta.name)
  return (
    <Drawer
      open
      size="xl"
      title={`Structure de ${meta.name}`}
      description={`${label ? `${label} · ` : ''}${String(meta.columns.length)} colonnes · ${COUNT.format(meta.row_count)} lignes`}
      onClose={onClose}
    >
      <div className="table-structure">
        <Table caption={`Colonnes de ${meta.name}`} density="compact">
          <thead>
            <tr>
              <th>Colonne</th>
              <th>Type</th>
              <th>NULL</th>
              <th>Défaut</th>
              <th>Clés</th>
              <th>Valeurs autorisées</th>
            </tr>
          </thead>
          <tbody>
            {meta.columns.map((column) => (
              <tr key={column.name}>
                <td className="table-structure__name">{column.name}</td>
                <td className="table-structure__code">{column.sql_type}</td>
                <td>{column.nullable ? 'oui' : 'non'}</td>
                <td className="table-structure__code">{column.default ?? '—'}</td>
                <td>
                  <span className="table-structure__keys">
                    {column.primary_key && <Badge tone="accent">Clé primaire</Badge>}
                    {column.foreign_key && (
                      <Link to={viewHref(column.foreign_key.table)} onClick={onClose} className="table-structure__fk">
                        → {column.foreign_key.table}.{column.foreign_key.column}
                      </Link>
                    )}
                    {column.masked && <Badge>Masquée</Badge>}
                  </span>
                </td>
                <td className="table-structure__code">{column.allowed_values?.join(', ') ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <section className="table-structure__references" aria-labelledby="table-structure-references">
          <h3 id="table-structure-references" className="eyebrow">
            Référencée par
          </h3>
          {meta.referenced_by.length === 0 ? (
            <p className="table-structure__empty">Aucune autre table ne référence {meta.name}.</p>
          ) : (
            <ul>
              {meta.referenced_by.map((reference) => (
                <li key={`${reference.table}.${reference.column}`}>
                  <Link to={viewHref(reference.table)} onClick={onClose} className="table-structure__fk">
                    {reference.table}.{reference.column}
                  </Link>
                  <span className="table-structure__arrow"> → {meta.name}.{reference.referenced_column}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}
