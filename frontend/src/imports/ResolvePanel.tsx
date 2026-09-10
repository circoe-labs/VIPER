import { type ReactNode, useState } from 'react'

import type {
  CategoryDecision,
  CategoryGroup,
  CompanyGroup,
  ImportReview,
  ProspectResolution,
  ReferentDecision,
  ReferentGroup,
  RoleDecision,
  RoleGroup,
} from '../api/imports'
import { ReferentSelect, TaxonomyMultiSelect, TaxonomySelect } from '../settings/selectors'
import { Badge, StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Checkbox, TextField } from '../ui/fields'
import { CheckCircleIcon } from '../ui/icons'
import {
  categoryDecision,
  companyDecision,
  isoWeekMonday,
  referentDecision,
  type ReviewDecisions,
  roleDecision,
  type RowIssue,
  weekYear,
  without,
} from './importPlan'
import {
  formatDay,
  ISSUE_LABELS,
  MATCH_STATUS_LABELS,
  reasonsText,
  REFERENT_STATUS_LABELS,
  rowsText,
} from './messages'
import { personName, ResolutionChoice } from './ResolutionChoice'
import type { Decide } from './ReviewStep'

interface ResolvePanelProps {
  review: ImportReview
  decisions: ReviewDecisions
  issues: Map<number, RowIssue>
  decide: Decide
  onOpenRow: (row: number) => void
}

// What the engine could not decide alone, grouped so that one choice applies to every row carrying the same raw
// value. Defaults never apply a suggestion, never create a Settings value and never guess a year: everything here is
// explicit. Values to create are created at import time, through the same audited Settings service.

function attention(review: ImportReview) {
  const rows = review.preview.rows
  const opposition = rows.filter(
    (row) =>
      row.blocked_by_do_not_contact ||
      row.diagnostics.some((item) => item.code === 'contactability.possible_do_not_contact'),
  )
  const oppositionRows = new Set(opposition.map((row) => row.row_number))
  return {
    opposition,
    duplicates: rows.filter((row) => row.duplicates.length > 0 && !oppositionRows.has(row.row_number)),
    companies: review.companies.filter((group) => group.candidates.length > 0),
    roles: review.roles.filter((group) => group.status !== 'exact'),
    categories: review.categories.filter((group) => group.status !== 'exact'),
    referents: review.referents.filter((group) => group.status !== 'exact'),
    inactive: rows.filter((row) => row.prospect.activity_status_suggestion === 'inactive'),
  }
}

// Number of groups and rows the panel asks the user to look at (errors included).
export function resolveCount(review: ImportReview): number {
  const found = attention(review)
  const errors = review.preview.rows.filter(
    (row) => row.diagnostics.some((item) => item.code === 'prospect.missing_name') && !found.opposition.includes(row),
  )
  return (
    errors.length +
    found.opposition.length +
    found.duplicates.length +
    found.companies.length +
    found.roles.length +
    found.categories.length +
    found.referents.length +
    review.weeks.length +
    review.civilities.length +
    found.inactive.length
  )
}

function Section({
  id,
  title,
  count,
  description,
  actions,
  children,
}: {
  id: string
  title: string
  count: number
  description: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="import-section" aria-labelledby={`import-section-${id}`}>
      <header className="import-section__header">
        <h3 id={`import-section-${id}`} className="import-section__title">
          {title} <Badge>{count}</Badge>
        </h3>
        {actions && <div className="import-section__actions">{actions}</div>}
      </header>
      <p className="import-section__description">{description}</p>
      <ul className="import-groups">{children}</ul>
    </section>
  )
}

function Group({ text, meta, badge, children }: { text: string; meta: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <li className="import-group">
      <div className="import-group__value">
        <span className="import-group__text">« {text} »</span>
        <span className="import-group__meta">
          {meta}
          {badge}
        </span>
      </div>
      <div className="import-group__control">{children}</div>
    </li>
  )
}

function Choice({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select
      aria-label={label}
      className="field__control field__control--select import-choice"
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    >
      {children}
    </select>
  )
}

const STATUS_TONES: Record<string, StatusTone> = {
  exact: 'success',
  suggested: 'info',
  partial: 'info',
  ambiguous: 'warning',
  inactive: 'warning',
  segment: 'info',
  unmatched: 'neutral',
  unknown: 'neutral',
}

// A mode picked in a select that has no complete decision yet (e.g. "existing" before a value is chosen) is kept
// only while the decision it was picked from is still the current one.
function usePendingMode(action: string): [string, (mode: string) => void] {
  const [pending, setPending] = useState<{ from: string; mode: string } | null>(null)
  const choose = (mode: string) => {
    setPending({ from: action, mode })
  }
  return [pending?.from === action ? pending.mode : action, choose]
}

// The label of a value to create, applied when the field is left (an empty text keeps the previous label).
function LabelInput({ label, value, onLabel }: { label: string; value: string; onLabel: (label: string) => void }) {
  const [text, setText] = useState(value)
  return (
    <TextField
      label={label}
      value={text}
      error={text.trim() ? undefined : `Saisissez un libellé : « ${value} » sera gardé sinon.`}
      hint="Créé dans Paramètres au moment de l’import, à votre nom."
      onChange={(event) => {
        setText(event.target.value)
      }}
      onBlur={() => {
        if (text.trim()) onLabel(text.trim())
        else setText(value)
      }}
    />
  )
}

function RoleItem({ group, decision, onChange }: { group: RoleGroup; decision: RoleDecision; onChange: (decision: RoleDecision) => void }) {
  const [mode, setMode] = usePendingMode(decision.action)
  const suggestion = group.suggestions[0]
  return (
    <Group
      text={group.text}
      meta={rowsText(group.rows.length)}
      badge={<StatusBadge tone={STATUS_TONES[group.status] ?? 'neutral'}>{MATCH_STATUS_LABELS[group.status]}</StatusBadge>}
    >
      <Choice
        label={`Rôle pour « ${group.text} »`}
        value={mode}
        onChange={(next) => {
          setMode(next)
          if (next === 'none') onChange({ action: 'none' })
          if (next === 'create') onChange({ action: 'create', label: group.text })
        }}
      >
        <option value="none">Laisser sans rôle</option>
        <option value="existing">Associer à un rôle existant</option>
        <option value="create">Créer un nouveau rôle</option>
      </Choice>
      {mode === 'existing' && (
        <TaxonomySelect
          kind="roles"
          label="Rôle existant"
          allowCreate={false}
          value={decision.action === 'existing' ? decision.role_id : null}
          onChange={(id) => {
            onChange(id ? { action: 'existing', role_id: id } : { action: 'none' })
          }}
        />
      )}
      {decision.action === 'create' && (
        <LabelInput
          label="Libellé du rôle à créer"
          value={decision.label}
          onLabel={(label) => {
            onChange({ action: 'create', label })
          }}
        />
      )}
      {suggestion && decision.action !== 'existing' && (
        <Button
          size="sm"
          onClick={() => {
            onChange({ action: 'existing', role_id: suggestion.id })
          }}
        >
          Utiliser « {suggestion.label} »
        </Button>
      )}
    </Group>
  )
}

function CategoryItem({
  group,
  decision,
  onChange,
}: {
  group: CategoryGroup
  decision: CategoryDecision
  onChange: (decision: CategoryDecision) => void
}) {
  const [mode, setMode] = usePendingMode(decision.action)
  const suggestion = group.suggestions[0]
  const segment = group.segment
  return (
    <Group
      text={group.text}
      meta={rowsText(group.rows.length)}
      badge={<StatusBadge tone={STATUS_TONES[group.status] ?? 'neutral'}>{MATCH_STATUS_LABELS[group.status]}</StatusBadge>}
    >
      <Choice
        label={`Catégorie pour « ${group.text} »`}
        value={mode}
        onChange={(next) => {
          setMode(next)
          if (next === 'ignore') onChange({ action: 'ignore' })
          if (next === 'create') onChange({ action: 'create', label: group.text })
          if (next === 'segment' && segment) onChange({ action: 'segment', segment_id: segment.id })
        }}
      >
        <option value="ignore">Ignorer (valeur d’origine conservée)</option>
        <option value="existing">Associer à des catégories existantes</option>
        <option value="create">Créer une nouvelle catégorie</option>
        {segment && <option value="segment">Segment commercial « {segment.label} »</option>}
      </Choice>
      {mode === 'existing' && (
        <TaxonomyMultiSelect
          kind="activity-categories"
          label="Catégories existantes"
          allowCreate={false}
          value={decision.action === 'existing' ? decision.category_ids : []}
          onChange={(ids) => {
            onChange(ids.length > 0 ? { action: 'existing', category_ids: ids } : { action: 'ignore' })
          }}
        />
      )}
      {decision.action === 'create' && (
        <LabelInput
          label="Libellé de la catégorie à créer"
          value={decision.label}
          onLabel={(label) => {
            onChange({ action: 'create', label })
          }}
        />
      )}
      {suggestion && decision.action !== 'existing' && (
        <Button
          size="sm"
          onClick={() => {
            onChange({ action: 'existing', category_ids: [suggestion.id] })
          }}
        >
          Utiliser « {suggestion.label} »
        </Button>
      )}
    </Group>
  )
}

function ReferentItem({
  group,
  decision,
  onChange,
}: {
  group: ReferentGroup
  decision: ReferentDecision
  onChange: (decision: ReferentDecision) => void
}) {
  const [mode, setMode] = usePendingMode(decision.action)
  return (
    <Group
      text={group.text}
      meta={rowsText(group.rows.length)}
      badge={<StatusBadge tone={STATUS_TONES[group.status] ?? 'neutral'}>{REFERENT_STATUS_LABELS[group.status]}</StatusBadge>}
    >
      <Choice
        label={`Référent pour « ${group.text} »`}
        value={mode}
        onChange={(next) => {
          setMode(next)
          if (next === 'ignore') onChange({ action: 'ignore' })
        }}
      >
        <option value="ignore">Ignorer (valeur d’origine conservée)</option>
        <option value="existing">Associer à un référent interne</option>
      </Choice>
      {mode === 'existing' && (
        <ReferentSelect
          label="Référent interne"
          allowCreate={false}
          value={decision.action === 'existing' ? decision.referent_id : null}
          onChange={(id) => {
            onChange(id ? { action: 'existing', referent_id: id } : { action: 'ignore' })
          }}
        />
      )}
      {decision.action !== 'existing' &&
        group.suggestions.map((suggestion) => (
          <Button
            key={suggestion.id}
            size="sm"
            onClick={() => {
              onChange({ action: 'existing', referent_id: suggestion.id })
            }}
          >
            Utiliser « {suggestion.display} »
          </Button>
        ))}
    </Group>
  )
}

function CompanyItem({ group, decisions, review, decide }: { group: CompanyGroup; decisions: ReviewDecisions; review: ImportReview; decide: Decide }) {
  const decision = companyDecision(review, decisions, group.key)
  return (
    <Group text={group.display_name} meta={rowsText(group.rows.length)}>
      <Choice
        label={`Entreprise pour « ${group.display_name} »`}
        value={decision.action === 'link' ? decision.company_id : 'create'}
        onChange={(next) => {
          decide((current) => ({
            ...current,
            companies: {
              ...current.companies,
              [group.key]: next === 'create' ? { action: 'create' } : { action: 'link', company_id: next },
            },
          }))
        }}
      >
        <option value="create">Créer une nouvelle entreprise</option>
        {group.candidates.map((candidate) => (
          <option key={candidate.company_id} value={candidate.company_id}>
            Rattacher à « {candidate.display_name} » — {reasonsText(candidate.reasons)}
          </option>
        ))}
      </Choice>
    </Group>
  )
}

const YEARS = (() => {
  const year = new Date().getFullYear()
  return [year - 1, year, year + 1]
})()

function yearValue(year: number | null): string {
  return year === null ? '' : String(year)
}

export function ResolvePanel({ review, decisions, issues, decide, onOpenRow }: ResolvePanelProps) {
  const found = attention(review)
  const errors = review.preview.rows.filter((row) => {
    const issue = issues.get(row.row_number)
    return issue !== undefined && issue !== 'blocked'
  })
  const setResolution = (row: number, resolution: ProspectResolution) => {
    decide((current) => ({ ...current, rows: { ...current.rows, [row]: { ...current.rows[row], resolution } } }))
  }
  const suggestedRoles = found.roles.filter(
    (group) => group.status === 'suggested' && roleDecision(review, decisions, group.key).action === 'none',
  )
  const nothing =
    errors.length +
      found.opposition.length +
      found.duplicates.length +
      found.companies.length +
      found.roles.length +
      found.categories.length +
      found.referents.length +
      review.weeks.length +
      review.civilities.length +
      found.inactive.length ===
    0

  if (nothing) {
    return (
      <EmptyState
        icon={CheckCircleIcon}
        title="Rien à résoudre"
        description="Toutes les valeurs ont été reconnues. Vérifiez les lignes si besoin, puis importez."
      />
    )
  }

  return (
    <div className="import-resolve">
      {errors.length > 0 && (
        <Section
          id="errors"
          title="Erreurs à traiter"
          count={errors.length}
          description="Ces lignes ne peuvent pas être importées telles quelles : corrigez-les, choisissez un doublon ou excluez-les."
          actions={
            <Button
              size="sm"
              onClick={() => {
                decide((current) => {
                  const rows = { ...current.rows }
                  for (const item of errors) rows[item.row_number] = { ...rows[item.row_number], resolution: { action: 'exclude' } }
                  return { ...current, rows }
                })
              }}
            >
              Exclure les lignes en erreur ({errors.length})
            </Button>
          }
        >
          {errors.map((item) => (
            <li key={item.row_number} className="import-group import-group--row">
              <div className="import-group__value">
                <span className="import-group__text">
                  Ligne {item.row_number} — {personName(item)}
                  {item.company && ` · ${item.company.display_name}`}
                </span>
                <span className="import-group__meta">{ISSUE_LABELS[issues.get(item.row_number) ?? 'missing_name']}</span>
              </div>
              <div className="import-group__control import-group__control--inline">
                <Button
                  size="sm"
                  onClick={() => {
                    onOpenRow(item.row_number)
                  }}
                >
                  Corriger la ligne {item.row_number}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setResolution(item.row_number, { action: 'exclude' })
                  }}
                >
                  Exclure la ligne {item.row_number}
                </Button>
              </div>
            </li>
          ))}
        </Section>
      )}

      {found.opposition.length > 0 && (
        <Section
          id="opposition"
          title="Opposition « Ne pas contacter »"
          count={found.opposition.length}
          description="Un prospect bloqué n’est jamais recréé ni réactivé : une ligne qui lui correspond est exclue ou le complète sans changer son opposition. Un simple homonyme reste importable."
        >
          {found.opposition.map((item) => (
            <li key={item.row_number} className="import-group import-group--wide">
              <ResolutionChoice
                review={review}
                decisions={decisions}
                row={item}
                onChange={(resolution) => {
                  setResolution(item.row_number, resolution)
                }}
              />
            </li>
          ))}
        </Section>
      )}

      {(found.duplicates.length > 0 || found.companies.length > 0) && (
        <Section
          id="duplicates"
          title="Doublons"
          count={found.duplicates.length + found.companies.length}
          description="Compléter un prospect existant ne remplit que ses champs vides et ajoute les coordonnées manquantes, sans rien écraser. Une entreprise rattachée n’est que complétée."
        >
          {found.duplicates.map((item) => (
            <li key={item.row_number} className="import-group import-group--wide">
              <ResolutionChoice
                review={review}
                decisions={decisions}
                row={item}
                onChange={(resolution) => {
                  setResolution(item.row_number, resolution)
                }}
              />
            </li>
          ))}
          {found.companies.map((group) => (
            <CompanyItem key={group.key} group={group} review={review} decisions={decisions} decide={decide} />
          ))}
        </Section>
      )}

      {found.roles.length > 0 && (
        <Section
          id="roles"
          title="Rôles non reconnus"
          count={found.roles.length}
          description="La fonction exacte est toujours conservée. Associez-la à un rôle existant, créez un rôle ou laissez la personne sans rôle."
          actions={
            suggestedRoles.length > 0 && (
              <Button
                size="sm"
                onClick={() => {
                  decide((current) => {
                    const roles = { ...current.roles }
                    for (const group of suggestedRoles) {
                      const suggestion = group.suggestions[0]
                      if (suggestion) roles[group.key] = { action: 'existing', role_id: suggestion.id }
                    }
                    return { ...current, roles }
                  })
                }}
              >
                Accepter les {suggestedRoles.length} suggestions
              </Button>
            )
          }
        >
          {found.roles.map((group) => (
            <RoleItem
              key={group.key}
              group={group}
              decision={roleDecision(review, decisions, group.key)}
              onChange={(decision) => {
                decide((current) => ({ ...current, roles: { ...current.roles, [group.key]: decision } }))
              }}
            />
          ))}
        </Section>
      )}

      {found.categories.length > 0 && (
        <Section
          id="categories"
          title="Catégories d’activité"
          count={found.categories.length}
          description="Chaque valeur de la colonne « Catégorie » : associée à des catégories, créée, reconnue comme segment ou ignorée (elle reste alors dans les valeurs d’origine)."
        >
          {found.categories.map((group) => (
            <CategoryItem
              key={group.key}
              group={group}
              decision={categoryDecision(review, decisions, group.key)}
              onChange={(decision) => {
                decide((current) => ({ ...current, categories: { ...current.categories, [group.key]: decision } }))
              }}
            />
          ))}
        </Section>
      )}

      {found.referents.length > 0 && (
        <Section
          id="referents"
          title="Référents"
          count={found.referents.length}
          description="Seul un référent interne Circoe peut devenir « Référent ». Les marqueurs, notes et adresses sont ignorés par défaut et conservés tels quels. Un référent absent se crée dans Paramètres, puis « Relancer l’analyse »."
        >
          {found.referents.map((group) => (
            <ReferentItem
              key={group.key}
              group={group}
              decision={referentDecision(review, decisions, group.key)}
              onChange={(decision) => {
                decide((current) => ({ ...current, referents: { ...current.referents, [group.key]: decision } }))
              }}
            />
          ))}
        </Section>
      )}

      {review.weeks.length > 0 && (
        <Section
          id="weeks"
          title="Semaines sans année"
          count={review.weeks.length}
          description="L’année n’est jamais devinée : choisissez-la pour tout le fichier ou semaine par semaine, ou laissez la date vide (la valeur d’origine est conservée)."
          actions={
            <Choice
              label="Année pour toutes les semaines"
              value={yearValue(decisions.weekYear)}
              onChange={(next) => {
                decide((current) => ({ ...current, weekYear: next ? Number(next) : null }))
              }}
            >
              <option value="">Toutes : laisser sans date</option>
              {YEARS.map((year) => (
                <option key={year} value={year}>
                  Toutes : {year}
                </option>
              ))}
            </Choice>
          }
        >
          {review.weeks.map((group) => {
            const year = weekYear(decisions, group.key)
            const monday = year === null ? null : isoWeekMonday(year, group.week)
            return (
              <Group
                key={group.key}
                text={`S${String(group.week)}`}
                meta={`${rowsText(group.rows.length)} · ${monday ? `lundi ${formatDay(monday)}` : year === null ? 'sans date' : `pas de semaine ${String(group.week)} en ${String(year)}`}`}
              >
                <Choice
                  label={`Année de la semaine ${String(group.week)}`}
                  value={group.key in decisions.weeks ? yearValue(decisions.weeks[group.key] ?? null) || 'none' : 'batch'}
                  onChange={(next) => {
                    decide((current) => ({
                      ...current,
                      weeks:
                        next === 'batch'
                          ? without(current.weeks, group.key)
                          : { ...current.weeks, [group.key]: next === 'none' ? null : Number(next) },
                    }))
                  }}
                >
                  <option value="batch">Comme toutes les semaines</option>
                  <option value="none">Laisser sans date</option>
                  {YEARS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Choice>
              </Group>
            )
          })}
        </Section>
      )}

      {review.civilities.length > 0 && (
        <Section
          id="civilities"
          title="Civilités non reconnues"
          count={review.civilities.length}
          description="Seuls M. et Mme sont enregistrés. Choisissez pour chaque valeur, ou laissez la civilité vide (valeur d’origine conservée)."
        >
          {review.civilities.map((group) => (
            <Group key={group.key} text={group.text} meta={rowsText(group.rows.length)}>
              <Choice
                label={`Civilité pour « ${group.text} »`}
                value={decisions.civilities[group.key] ?? ''}
                onChange={(next) => {
                  decide((current) => ({
                    ...current,
                    civilities: { ...current.civilities, [group.key]: next === 'mr' || next === 'ms' ? next : null },
                  }))
                }}
              >
                <option value="">Laisser vide</option>
                <option value="mr">M.</option>
                <option value="ms">Mme</option>
              </Choice>
            </Group>
          ))}
        </Section>
      )}

      {found.inactive.length > 0 && (
        <Section
          id="activity"
          title="Activité (retraite, départ…)"
          count={found.inactive.length}
          description="Le fichier suggère que la personne n’est plus en activité. L’import ne change l’activité que si vous le confirmez."
        >
          {found.inactive.map((item) => (
            <li key={item.row_number} className="import-group">
              <Checkbox
                label={`Ligne ${String(item.row_number)} — ${personName(item)} : marquer « Inactif »`}
                checked={Boolean(decisions.rows[item.row_number]?.inactive)}
                onChange={(event) => {
                  const inactive = event.target.checked
                  decide((current) => ({
                    ...current,
                    rows: { ...current.rows, [item.row_number]: { ...current.rows[item.row_number], inactive } },
                  }))
                }}
              />
            </li>
          ))}
        </Section>
      )}
    </div>
  )
}
