import type { ImportReview, PreviewRow, ProspectResolution } from '../api/imports'
import { resolutionOf, type ReviewDecisions } from './importPlan'
import { reasonsText } from './messages'

interface Option {
  value: string
  label: string
  resolution: ProspectResolution
}

const PERSON_REASONS = new Set(['same_email', 'same_person'])

function valueOf(resolution: ProspectResolution): string {
  switch (resolution.action) {
    case 'attach':
      return `attach:${resolution.prospect_id}`
    case 'attach_row':
      return `row:${String(resolution.row)}`
    default:
      return resolution.action
  }
}

export function personName(row: PreviewRow): string {
  const name = [row.prospect.first_name, row.prospect.last_name].filter(Boolean).join(' ')
  return name || 'Sans nom'
}

// What to do with a row that may duplicate someone: create, complete an existing prospect, merge into another row of
// the file, or exclude it. A row matching a « Ne pas contacter » prospect can only be excluded or attached to that
// prospect, which stays blocked.
export function ResolutionChoice({
  review,
  decisions,
  row,
  onChange,
}: {
  review: ImportReview
  decisions: ReviewDecisions
  row: PreviewRow
  onChange: (resolution: ProspectResolution) => void
}) {
  const current = valueOf(resolutionOf(review, decisions, row.row_number))
  const blocked = row.blocked_by_do_not_contact
  const prospects = new Map(review.prospects.map((prospect) => [prospect.id, prospect]))
  const options: Option[] = []
  if (!blocked) options.push({ value: 'create', label: 'Créer un nouveau prospect', resolution: { action: 'create' } })
  for (const candidate of row.duplicates) {
    const id = candidate.prospect_id
    const prospect = id ? prospects.get(id) : undefined
    if (candidate.kind !== 'existing_prospect' || !id || !prospect) continue
    const doNotContact = candidate.contactability === 'do_not_contact'
    if (blocked && !(doNotContact && candidate.reasons.some((reason) => PERSON_REASONS.has(reason)))) continue
    const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ')
    const company = prospect.company_name ? ` (${prospect.company_name})` : ''
    const warning = doNotContact ? ' — reste « Ne pas contacter »' : ''
    options.push({
      value: `attach:${id}`,
      label: `Compléter le prospect existant « ${name} »${company} — ${reasonsText(candidate.reasons)}${warning}`,
      resolution: { action: 'attach', prospect_id: id },
    })
  }
  if (!blocked) {
    for (const candidate of row.duplicates) {
      const other = review.preview.rows.find((item) => item.row_number === candidate.row)
      if (candidate.kind !== 'file_row' || !other) continue
      options.push({
        value: `row:${String(other.row_number)}`,
        label: `Fusionner avec la ligne ${String(other.row_number)} (${personName(other)}) — ${reasonsText(candidate.reasons)}`,
        resolution: { action: 'attach_row', row: other.row_number },
      })
    }
  }
  options.push({ value: 'exclude', label: 'Exclure la ligne (ne pas l’importer)', resolution: { action: 'exclude' } })

  return (
    <fieldset className="import-resolution">
      <legend className="import-resolution__legend">
        Ligne {row.row_number} — {personName(row)}
        {row.company && ` · ${row.company.display_name}`}
      </legend>
      {options.map((option) => (
        <label key={option.value} className="import-radio">
          <input
            type="radio"
            name={`resolution-${String(row.row_number)}`}
            checked={current === option.value}
            onChange={() => {
              onChange(option.resolution)
            }}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}
