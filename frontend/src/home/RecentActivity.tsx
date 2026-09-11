import { Link } from 'react-router'

import type { EditItem } from '../api/home'
import type { ImportBatch } from '../api/imports'
import { BATCH_STATUS } from '../imports/ImportHistory'
import { prospectionHref } from '../prospection/criteria'
import { StatusBadge } from '../ui/Badge'
import { describeEdit, editOrigin, editSubject, formatMoment, importCounts } from './activity'

function ImportLine({ batch }: { batch: ImportBatch }) {
  const status = BATCH_STATUS[batch.status]
  return (
    <li className="activity-item">
      <div className="activity-item__head">
        {batch.status === 'committed' ? (
          <Link className="activity-item__title" to={prospectionHref({ import_batch: batch.id })}>
            {batch.filename}
          </Link>
        ) : (
          <span className="activity-item__title">{batch.filename}</span>
        )}
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>
      <span className="activity-item__detail">{importCounts(batch)}</span>
      <span className="activity-item__meta">
        {batch.actor_display} · {formatMoment(batch.committed_at ?? batch.created_at)}
      </span>
    </li>
  )
}

function EditLine({ edit }: { edit: EditItem }) {
  const subject = editSubject(edit)
  return (
    <li className="activity-item">
      <div className="activity-item__head">
        {edit.subject_type === 'prospect' && edit.subject_id && edit.subject_label ? (
          <Link className="activity-item__title" to={prospectionHref({ prospect: edit.subject_id })}>
            {subject}
          </Link>
        ) : (
          <span className="activity-item__title">{subject}</span>
        )}
      </div>
      <span className="activity-item__detail">{describeEdit(edit)}</span>
      <span className="activity-item__meta">
        {editOrigin(edit)} · {formatMoment(edit.occurred_at)}
      </span>
    </li>
  )
}

// Recent activity (Task 16): the latest imports (a committed one opens Prospection filtered on it) and the latest
// manual saves on prospects and companies. Task 19 will enrich the edit lines from the same data.
export function RecentActivity({ imports, edits }: { imports: ImportBatch[]; edits: EditItem[] }) {
  return (
    <>
      <section className="home-panel" aria-labelledby="home-imports-title">
        <h2 id="home-imports-title" className="home-panel__title">
          Derniers imports
        </h2>
        {imports.length === 0 ? (
          <p className="home-panel__empty">Aucun import pour l’instant.</p>
        ) : (
          <ul className="activity-list" aria-labelledby="home-imports-title">
            {imports.map((batch) => (
              <ImportLine key={batch.id} batch={batch} />
            ))}
          </ul>
        )}
        <Link className="action-group__more" to="/prospection/import">
          Historique des imports
        </Link>
      </section>
      <section className="home-panel" aria-labelledby="home-edits-title">
        <h2 id="home-edits-title" className="home-panel__title">
          Dernières modifications
        </h2>
        {edits.length === 0 ? (
          <p className="home-panel__empty">Aucune modification manuelle pour l’instant.</p>
        ) : (
          <ul className="activity-list" aria-labelledby="home-edits-title">
            {edits.map((edit) => (
              <EditLine key={`${edit.occurred_at}-${edit.subject_id ?? ''}`} edit={edit} />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
