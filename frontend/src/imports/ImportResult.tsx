import { Link } from 'react-router'

import type { CommitResult } from '../api/imports'
import { viewHref } from '../database/explorerView'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { CheckCircleIcon } from '../ui/icons'
import { plural, rowsText } from './messages'

// What the committed import created, completed and skipped, with links to the traced rows in the explorer.
export function ImportResult({ result, onRestart }: { result: CommitResult; onRestart: () => void }) {
  const { batch, counts } = result
  const count = (key: string) => counts[key] ?? 0
  const byBatch = { filters: [{ column: 'import_batch_id', operator: 'eq' as const, value: batch.id }] }
  const lines = [
    plural(count('prospects_created'), 'prospect créé', 'prospects créés'),
    count('prospects_attached') > 0 &&
      plural(count('prospects_attached'), 'prospect existant complété', 'prospects existants complétés'),
    count('rows_merged') > 0 && `${rowsText(count('rows_merged'))} fusionnée(s) avec une autre ligne`,
    plural(count('companies_created'), 'entreprise créée', 'entreprises créées'),
    count('companies_linked') > 0 && plural(count('companies_linked'), 'entreprise existante', 'entreprises existantes'),
    plural(count('emails_added'), 'adresse e-mail', 'adresses e-mail'),
    plural(count('phones_added'), 'numéro de téléphone', 'numéros de téléphone'),
    count('trackings_created') > 0 && plural(count('trackings_created'), 'suivi de contact', 'suivis de contact'),
    count('roles_created') > 0 && plural(count('roles_created'), 'rôle créé', 'rôles créés'),
    count('categories_created') > 0 && plural(count('categories_created'), 'catégorie créée', 'catégories créées'),
  ].filter((line): line is string => typeof line === 'string')

  return (
    <Card title="Import terminé" className="import-card import-result">
      <p className="import-result__lead">
        <CheckCircleIcon size={22} />
        <span>
          « {batch.filename} » : {rowsText(batch.rows_imported)} importées, {rowsText(batch.rows_skipped)} exclues. Les
          coordonnées importées sont « non vérifiées » tant que vous ne les avez pas confirmées.
        </span>
      </p>
      <ul className="import-result__counts" aria-label="Résultat de l’import">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="import-result__actions">
        <Link className="btn btn--secondary btn--md" to={viewHref('prospect_sources', byBatch)}>
          Voir les prospects du lot
        </Link>
        <Link className="btn btn--secondary btn--md" to={viewHref('import_row_metadata', byBatch)}>
          Voir les lignes conservées
        </Link>
        <Button variant="primary" onClick={onRestart}>
          Importer un autre fichier
        </Button>
      </div>
    </Card>
  )
}
