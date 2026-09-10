import { type SubmitEvent, useState } from 'react'

import {
  CORRECTABLE_FIELDS,
  type CorrectableField,
  type ImportReview,
  type JsonScalar,
  type LegacyValue,
  type PreviewRow,
} from '../api/imports'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, InfoIcon, PencilIcon } from '../ui/icons'
import {
  companyDecision,
  isoWeekMonday,
  referentDecision,
  resolutionOf,
  type ReviewDecisions,
  roleDecision,
  type RowIssue,
  weekYear,
  without,
} from './importPlan'
import { fieldLabel, formatDay, ISSUE_LABELS, resolutionLabel } from './messages'
import { ResolutionChoice } from './ResolutionChoice'
import type { Decide } from './ReviewStep'

interface RowDetailProps {
  review: ImportReview
  decisions: ReviewDecisions
  decide: Decide
  reanalyzing: boolean
  onReanalyse: (decisions?: ReviewDecisions) => void
  row: PreviewRow
  issue: RowIssue | null
}

const LEGACY_REASONS: Record<LegacyValue['reason'], string> = {
  unmapped_column: 'colonne non reconnue',
  opaque_field: 'conservée telle quelle',
  not_mapped_value: 'non reprise telle quelle',
  corrected: 'valeur d’origine, corrigée',
}
const CIVILITIES = { mr: 'M.', ms: 'Mme' } as const
const STAGES: Record<string, string> = {
  to_contact: 'À contacter',
  follow_up_1: 'Relance 1',
  follow_up_2: 'Relance 2',
  appointment_obtained: 'RDV obtenu',
  quote_sent: 'Devis envoyé',
  quote_follow_up: 'Suivi du devis',
}

function text(value: JsonScalar): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'VRAI' : 'FAUX'
  return String(value)
}

// One row: why it needs attention, what the import will write, what to do with its duplicates, its preserved
// original values, and the correction form (a correction re-runs the analysis on the corrected value).
export function RowDetail({ review, decisions, decide, reanalyzing, onReanalyse, row, issue }: RowDetailProps) {
  const number = row.row_number
  const resolution = resolutionOf(review, decisions, number)
  const reviewRow = review.rows.find((item) => item.row_number === number)
  const legacy = Object.entries(row.legacy_metadata)
  const setResolution = (next: typeof resolution) => {
    decide((current) => ({ ...current, rows: { ...current.rows, [number]: { ...current.rows[number], resolution: next } } }))
  }

  const role = reviewRow?.role_key ? roleDecision(review, decisions, reviewRow.role_key) : null
  const group = review.roles.find((item) => item.key === reviewRow?.role_key)
  const roleText =
    role?.action === 'existing'
      ? (group?.suggestions.find((match) => match.id === role.role_id)?.label ?? 'rôle choisi')
      : role?.action === 'create'
        ? `« ${role.label} » (créé à l’import)`
        : 'sans rôle'
  const company = reviewRow?.company_key ? companyDecision(review, decisions, reviewRow.company_key) : null
  const candidate = row.company?.candidates.find((item) => company?.action === 'link' && item.company_id === company.company_id)
  const planned = row.tracking?.planned_contact
  const year = reviewRow?.week_key ? weekYear(decisions, reviewRow.week_key) : null
  const monday = planned?.week && year !== null ? isoWeekMonday(year, planned.week) : null
  const plannedText = planned?.planned_date
    ? formatDay(new Date(`${planned.planned_date}T00:00:00Z`))
    : monday
      ? formatDay(monday)
      : planned?.requires_year
        ? `semaine ${String(planned.week)} sans année : sans date`
        : null
  const referent = reviewRow?.referent_key ? referentDecision(review, decisions, reviewRow.referent_key) : null
  const referentGroup = review.referents.find((item) => item.key === reviewRow?.referent_key)
  const referentText =
    referent?.action === 'existing'
      ? (referentGroup?.suggestions.find((match) => match.id === referent.referent_id)?.display ?? 'référent choisi')
      : null
  const civility = row.prospect.civility ?? (reviewRow?.civility_key ? decisions.civilities[reviewRow.civility_key] : null)

  return (
    <div className="import-detail">
      {issue && (
        <p className="import-alert import-alert--danger">
          <AlertIcon size={18} />
          {ISSUE_LABELS[issue]}
        </p>
      )}
      <div className="import-detail__grid">
        <section className="import-detail__block" aria-label={`Remarques de la ligne ${String(number)}`}>
          <h4 className="import-detail__title">Remarques</h4>
          {row.diagnostics.length === 0 ? (
            <p className="import-muted">Aucune remarque.</p>
          ) : (
            <ul className="import-diagnostics">
              {row.diagnostics.map((item, index) => (
                <li key={`${item.code}-${String(index)}`} data-severity={item.severity}>
                  {item.severity === 'info' ? <InfoIcon size={16} /> : <AlertIcon size={16} />}
                  <span>
                    {item.message}
                    {item.column && <span className="import-diagnostics__column"> — colonne {item.column}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="import-detail__block" aria-label={`Import de la ligne ${String(number)}`}>
          <h4 className="import-detail__title">Ce qui sera importé — {resolutionLabel(resolution)}</h4>
          <dl className="import-facts">
            <dt>Prospect</dt>
            <dd>
              {[civility ? CIVILITIES[civility] : null, row.prospect.first_name, row.prospect.last_name]
                .filter(Boolean)
                .join(' ') || '—'}
            </dd>
            <dt>Fonction</dt>
            <dd>{row.prospect.exact_job_title ? `${row.prospect.exact_job_title} → ${roleText}` : '—'}</dd>
            <dt>Entreprise</dt>
            <dd>
              {row.company
                ? `${row.company.display_name} — ${candidate ? `rattachée à « ${candidate.display_name} »` : 'nouvelle entreprise'}`
                : '—'}
            </dd>
            <dt>E-mails</dt>
            <dd>
              {row.emails.map((email) => `${email.address}${email.is_primary ? ' (principale)' : ''}`).join(', ') || '—'}
            </dd>
            <dt>Téléphones</dt>
            <dd>{row.phones.map((phone) => `${phone.number}${phone.is_primary ? ' (principal)' : ''}`).join(', ') || '—'}</dd>
            <dt>Suivi</dt>
            <dd>
              {[
                row.tracking?.stages.length ? STAGES[row.tracking.status] : null,
                plannedText && `à contacter : ${plannedText}`,
                referentText && `référent : ${referentText}`,
              ]
                .filter(Boolean)
                .join(' · ') || 'aucun'}
            </dd>
          </dl>
        </section>
      </div>
      {row.duplicates.length > 0 || row.blocked_by_do_not_contact ? (
        <ResolutionChoice review={review} decisions={decisions} row={row} onChange={setResolution} />
      ) : (
        <div className="import-detail__actions">
          <Button
            size="sm"
            onClick={() => {
              setResolution(resolution.action === 'exclude' ? { action: 'create' } : { action: 'exclude' })
            }}
          >
            {resolution.action === 'exclude' ? 'Réintégrer la ligne' : 'Exclure la ligne'}
          </Button>
        </div>
      )}
      <CorrectionForm
        key={JSON.stringify(decisions.corrections[number] ?? {})}
        review={review}
        decisions={decisions}
        row={row}
        reanalyzing={reanalyzing}
        onReanalyse={onReanalyse}
      />
      {legacy.length > 0 && (
        <details className="import-detail__legacy">
          <summary>Valeurs d’origine conservées ({legacy.length})</summary>
          <table className="import-mini-table">
            <thead>
              <tr>
                <th scope="col">Colonne</th>
                <th scope="col">Valeur</th>
                <th scope="col">Pourquoi</th>
              </tr>
            </thead>
            <tbody>
              {legacy.map(([key, value]) => (
                <tr key={key}>
                  <td>
                    {value.column} {value.header && `« ${value.header.trim()} »`}
                  </td>
                  <td className="import-mini-table__value">{text(value.value)}</td>
                  <td>{LEGACY_REASONS[value.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}

function CorrectionForm({
  review,
  decisions,
  row,
  reanalyzing,
  onReanalyse,
}: Pick<RowDetailProps, 'review' | 'decisions' | 'row' | 'reanalyzing' | 'onReanalyse'>) {
  const number = row.row_number
  const columns = new Map(review.preview.summary.columns.flatMap((column) => (column.field ? [[column.field, column.column]] : [])))
  const fields = CORRECTABLE_FIELDS.filter((field) => columns.has(field))
  const original = (field: CorrectableField) =>
    text(row.cells.find((cell) => cell.column === columns.get(field))?.value ?? null)
  const saved = decisions.corrections[number] ?? {}
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field, field in saved ? (saved[field] ?? '') : original(field)])),
  )
  const [open, setOpen] = useState(row.status === 'error')

  function apply(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const corrections: Partial<Record<CorrectableField, string | null>> = {}
    for (const field of fields) {
      const value = (values[field] ?? '').trim()
      if (value !== original(field).trim()) corrections[field] = value || null
    }
    const others = without(decisions.corrections, number)
    onReanalyse({
      ...decisions,
      corrections: Object.keys(corrections).length > 0 ? { ...others, [number]: corrections } : others,
    })
  }

  return (
    <details
      className="import-detail__correction"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
      }}
    >
      <summary>
        <PencilIcon size={16} />
        Corriger la ligne {number}
        {Object.keys(saved).length > 0 && ' (corrigée)'}
      </summary>
      <form className="import-correction" onSubmit={apply} aria-label={`Correction de la ligne ${String(number)}`}>
        <p className="import-muted">
          La valeur corrigée est analysée comme celle du fichier (doublons et opposition compris) ; la valeur d’origine
          reste conservée. Un champ vidé est importé vide.
        </p>
        <div className="import-correction__fields">
          {fields.map((field) => (
            <TextField
              key={field}
              label={fieldLabel(field)}
              value={values[field] ?? ''}
              hint={field === 'civility' ? 'M. ou Mme' : field === 'planned_contact' ? 'S37 2026 ou 14/09/2026' : undefined}
              onChange={(event) => {
                setValues((current) => ({ ...current, [field]: event.target.value }))
              }}
            />
          ))}
        </div>
        <div className="import-correction__actions">
          {Object.keys(saved).length > 0 && (
            <Button
              disabled={reanalyzing}
              onClick={() => {
                onReanalyse({ ...decisions, corrections: without(decisions.corrections, number) })
              }}
            >
              Annuler les corrections
            </Button>
          )}
          <Button type="submit" variant="primary" loading={reanalyzing}>
            Appliquer et relancer l’analyse
          </Button>
        </div>
      </form>
    </details>
  )
}
