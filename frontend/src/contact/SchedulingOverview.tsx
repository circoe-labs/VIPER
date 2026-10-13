import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import {
  type ForgottenProspect,
  type ForgottenState,
  type PreparedMessage,
  type Scheduling,
  useContactScheduling,
} from '../api/contact'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, CalendarIcon, ChevronDownIcon, SpinnerIcon } from '../ui/icons'
import { CONNECTIONS_PATH } from './dispatchCopy'
import { formatDateTime } from './labels'

const NUMBER = new Intl.NumberFormat('fr-FR')
const FORGOTTEN_SHOWN = 50

const STATE_TEXT: Record<ForgottenState, { label: string; tone: 'danger' | 'warning' | 'info' }> = {
  none: { label: 'Rien d’écrit', tone: 'danger' },
  draft: { label: 'Brouillon à valider', tone: 'warning' },
  validated: { label: 'Validé, à programmer', tone: 'info' },
}

// The colour of a step in the charts: Contact then R1, R2… take the categorical slots in a fixed order (the slot is the
// rank), whatever is shown; the step is always also named in text.
function stepSlot(step: string): number {
  return step === 'contact' ? 1 : Math.min(Number(step.slice(1)) + 1, 8)
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Paris' })
}

function personName(row: ForgottenProspect): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Sans nom'
}

type Selection = 'scheduled' | 'validated' | 'drafts' | 'forgotten'

// A tile is a button: it opens the list of the prospects it counts, right under the tiles.
function Tile({
  tone,
  value,
  label,
  hint,
  selected,
  onSelect,
}: {
  tone: 'ok' | 'todo' | 'idle' | 'alert'
  value: number
  label: string
  hint: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={`sched-tile sched-tile--${tone}${selected ? ' sched-tile--selected' : ''}`}
      aria-pressed={selected}
      disabled={value === 0}
      onClick={onSelect}
    >
      <span className="sched-tile__value">{NUMBER.format(value)}</span>
      <span className="sched-tile__label">{label}</span>
      <span className="sched-tile__hint">{hint}</span>
    </button>
  )
}

function StepDot({ step }: { step: string }) {
  return <span className={`sched-dot sched-slot-${String(stepSlot(step))}`} aria-hidden="true" />
}

// Scheduled mails per business day, stacked by step; the numbers are on the bars and in the table below.
function DaysChart({ data }: { data: Scheduling }) {
  if (data.days.length === 0) return <p className="contact__state">Aucun mail n’est programmé pour le moment.</p>
  const peak = Math.max(...data.days.map((day) => day.total))
  const present = data.steps.filter((step) => data.days.some((day) => (day.by_step[step.step] ?? 0) > 0))
  return (
    <div className="sched-chart">
      <h3 className="sched-subtitle">Programmés par jour</h3>
      <ul className="sched-legend" aria-label="Étapes">
        {present.map((step) => (
          <li key={step.step}>
            <StepDot step={step.step} />
            {step.step_label}
          </li>
        ))}
      </ul>
      <div
        className="sched-bars"
        role="img"
        aria-label={`Mails programmés par jour : ${data.days.map((day) => `${dayLabel(day.day)} ${String(day.total)}`).join(', ')}`}
      >
        {data.days.map((day) => (
          <div key={day.day} className={`sched-bar${day.past ? ' sched-bar--past' : ''}`}>
            <span className="sched-bar__total">{day.total}</span>
            <div className="sched-bar__stack" style={{ height: `${String(Math.max((day.total / peak) * 100, 6))}%` }}>
              {data.steps
                .filter((step) => (day.by_step[step.step] ?? 0) > 0)
                .map((step) => (
                  <span
                    key={step.step}
                    className={`sched-bar__part sched-slot-${String(stepSlot(step.step))}`}
                    style={{ flexGrow: day.by_step[step.step] }}
                    title={`${step.step_label} : ${String(day.by_step[step.step])}`}
                  />
                ))}
            </div>
            <span className="sched-bar__day">{dayLabel(day.day)}</span>
            {day.past && <span className="sched-bar__late">passé</span>}
          </div>
        ))}
      </div>
      <details className="sched-days-table">
        <summary>Voir en tableau</summary>
        <table className="sched-table">
          <thead>
            <tr>
              <th scope="col">Jour</th>
              {present.map((step) => (
                <th key={step.step} scope="col">
                  {step.step_label}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{dayLabel(day.day)}</th>
                {present.map((step) => (
                  <td key={step.step}>{day.by_step[step.step] ?? 0}</td>
                ))}
                <td>{day.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function missingDetail(step: Scheduling['steps'][number]): string {
  return [
    step.forgotten_none > 0 && `${String(step.forgotten_none)} sans mail`,
    step.forgotten_draft > 0 && `${String(step.forgotten_draft)} brouillon`,
    step.forgotten_validated > 0 && `${String(step.forgotten_validated)} validé`,
  ]
    .filter(Boolean)
    .join(', ')
}

// A count of the table that opens the list behind it, for that step only (nothing to open at zero).
function CountButton({
  value,
  label,
  step,
  selection,
  onPick,
  active,
  detail,
}: {
  value: number
  label: string
  step: Scheduling['steps'][number]
  selection: Selection
  onPick: (selection: Selection, step: string) => void
  active: boolean
  // What is behind the count, read inside the button so the whole cell opens the list (« (1 validé) »).
  detail?: string
}) {
  if (value === 0) return <>{value}</>
  return (
    <button
      type="button"
      className={`sched-cell__button${active ? ' sched-cell__button--active' : ''}`}
      aria-pressed={active}
      aria-label={`${label} ${step.step_label} : ${String(value)}, voir la liste`}
      onClick={() => {
        onPick(selection, step.step)
      }}
    >
      {value}
      {detail && <span className="sched-cell__detail">{detail}</span>}
    </button>
  )
}

function StepsTable({
  data,
  selection,
  stepFilter,
  onPick,
}: {
  data: Scheduling
  selection: Selection | null
  stepFilter: string | null
  onPick: (selection: Selection, step: string) => void
}) {
  const on = (kind: Selection, step: string) => selection === kind && stepFilter === step
  return (
    <table className="sched-table">
      <caption className="sched-caption">Par étape (« à envoyer » = prévu cette semaine ou avant)</caption>
      <thead>
        <tr>
          <th scope="col">Étape</th>
          <th scope="col">À envoyer</th>
          <th scope="col">Programmés</th>
          <th scope="col">Validés</th>
          <th scope="col">Brouillons</th>
          <th scope="col">Oubliés</th>
        </tr>
      </thead>
      <tbody>
        {data.steps.map((step) => (
          <tr key={step.step}>
            <th scope="row">
              <StepDot step={step.step} />
              {step.step_label}
            </th>
            <td>{step.due}</td>
            <td className={step.scheduled > 0 ? 'sched-cell--ok' : undefined}>
              <CountButton value={step.scheduled} label="Programmés" step={step} selection="scheduled" onPick={onPick} active={on('scheduled', step.step)} />
            </td>
            <td className={step.validated > 0 ? 'sched-cell--todo' : undefined}>
              <CountButton value={step.validated} label="Validés" step={step} selection="validated" onPick={onPick} active={on('validated', step.step)} />
            </td>
            <td>
              <CountButton value={step.drafts} label="Brouillons" step={step} selection="drafts" onPick={onPick} active={on('drafts', step.step)} />
            </td>
            <td className={step.forgotten > 0 ? 'sched-cell--alert' : undefined}>
              <CountButton
                value={step.forgotten}
                label="Oubliés"
                step={step}
                selection="forgotten"
                onPick={onPick}
                active={on('forgotten', step.step)}
                detail={step.forgotten > 0 ? ` (${missingDetail(step)})` : undefined}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Forgotten({
  data,
  openHref,
  step,
}: {
  data: Scheduling
  openHref: (id: string) => string
  step: string | null
}) {
  const [all, setAll] = useState(false)
  const list = step === null ? data.forgotten : data.forgotten.filter((row) => row.step === step)
  const rows = all ? list : list.slice(0, FORGOTTEN_SHOWN)
  if (list.length === 0) {
    return (
      <p className="sched-ok" role="status">
        <StatusBadge tone="success">Aucun oubli</StatusBadge>
        Chaque mail à envoyer cette semaine est programmé.
      </p>
    )
  }
  return (
    <div className="sched-forgotten">
      <h3 className="sched-forgotten__title">
        <AlertIcon size={16} />
        {NUMBER.format(list.length)} à envoyer cette semaine sans être programmé
      </h3>
      <ul className="sched-forgotten__list">
        {rows.map((row) => (
          <li key={`${row.id}-${row.step}`} className="sched-forgotten__row">
            <span className="sched-forgotten__step">
              <StepDot step={row.step} />
              {row.step_label}
            </span>
            <a className="sched-forgotten__name" href={openHref(row.id)}>
              {personName(row)}
            </a>
            <span className="sched-forgotten__company">{row.company_name ?? 'Sans entreprise'}</span>
            <span className="sched-forgotten__cohort">{row.cohort_code}</span>
            <StatusBadge tone={STATE_TEXT[row.state].tone}>{STATE_TEXT[row.state].label}</StatusBadge>
            {row.due_at && (
              <span className="sched-forgotten__due">prévu le {shortDay(row.due_at)}</span>
            )}
          </li>
        ))}
      </ul>
      {!all && list.length > FORGOTTEN_SHOWN && (
        <Button
          size="sm"
          onClick={() => {
            setAll(true)
          }}
        >
          Voir les {NUMBER.format(list.length - FORGOTTEN_SHOWN)} autres
        </Button>
      )}
    </div>
  )
}

const MESSAGE_STATE: Record<PreparedMessage['status'], { label: string; tone: 'info' | 'warning' | 'success' }> = {
  draft: { label: 'Brouillon à valider', tone: 'warning' },
  validated: { label: 'Validé, à programmer', tone: 'info' },
  scheduled: { label: 'Programmé', tone: 'success' },
}

const LIST_TITLES: Record<Exclude<Selection, 'forgotten'>, string> = {
  scheduled: 'Mails programmés',
  validated: 'Mails validés, à programmer',
  drafts: 'Brouillons à relire et valider',
}

function Prepared({
  data,
  selection,
  openHref,
  step,
}: {
  data: Scheduling
  selection: Exclude<Selection, 'forgotten'>
  openHref: (id: string) => string
  step: string | null
}) {
  const [all, setAll] = useState(false)
  const status = selection === 'drafts' ? 'draft' : selection
  const matching = data.messages.filter((message) => message.status === status && (step === null || message.step === step))
  const rows = all ? matching : matching.slice(0, FORGOTTEN_SHOWN)
  return (
    <div className="sched-forgotten">
      <h3 className="sched-subtitle">
        {LIST_TITLES[selection]} ({NUMBER.format(matching.length)})
      </h3>
      <ul className="sched-forgotten__list">
        {rows.map((row) => (
          <li key={`${row.prospect_id}-${row.step}`} className="sched-forgotten__row">
            <span className="sched-forgotten__step">
              <StepDot step={row.step} />
              {row.step_label}
            </span>
            <a className="sched-forgotten__name" href={openHref(row.prospect_id)}>
              {[row.first_name, row.last_name].filter(Boolean).join(' ') || 'Sans nom'}
            </a>
            <span className="sched-forgotten__company">{row.company_name ?? 'Sans entreprise'}</span>
            <span className="sched-forgotten__cohort">{row.cohort_code}</span>
            <StatusBadge tone={MESSAGE_STATE[row.status].tone}>{MESSAGE_STATE[row.status].label}</StatusBadge>
            {row.scheduled_at && <span className="sched-forgotten__due">le {formatDateTime(row.scheduled_at)}</span>}
            {row.last_error_code && <StatusBadge tone="danger">Erreur d’envoi : {row.last_error_code}</StatusBadge>}
          </li>
        ))}
      </ul>
      {!all && matching.length > FORGOTTEN_SHOWN && (
        <Button
          size="sm"
          onClick={() => {
            setAll(true)
          }}
        >
          Voir les {NUMBER.format(matching.length - FORGOTTEN_SHOWN)} autres
        </Button>
      )}
    </div>
  )
}

interface SchedulingOverviewProps {
  openHref: (id: string) => string
}

// Contact › « Suivi des envois programmés »: how many mails are scheduled, at which step and on which day, what is
// still to validate or schedule, and the « oubliés » — prospects with a step to send this week and no scheduled mail.
export function SchedulingOverview({ openHref }: SchedulingOverviewProps) {
  const scheduling = useContactScheduling()
  const [open, setOpen] = useState(true)
  const [selection, setSelection] = useState<Selection | null>(null)
  // A count of the table by step opens its list for that step only; the tiles open it for every step.
  const [stepFilter, setStepFilter] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    // jsdom (the tests) has no scrollIntoView.
    if (selection !== null && list && typeof list.scrollIntoView === 'function') {
      list.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selection, stepFilter])
  const toggleSelection = (next: Selection) => {
    setStepFilter(null)
    setSelection((current) => (current === next ? null : next))
  }
  const pickStep = (next: Selection, step: string) => {
    if (selection === next && stepFilter === step) {
      setSelection(null)
      setStepFilter(null)
    } else {
      setSelection(next)
      setStepFilter(step)
    }
  }
  const data = scheduling.data
  return (
    <section className="sched" aria-labelledby="sched-title">
      <h2 className="sched__heading" id="sched-title">
        <button
          type="button"
          className="sched__toggle"
          aria-expanded={open}
          aria-controls="sched-body"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronDownIcon size={18} className="sched__arrow" />
          <CalendarIcon size={18} />
          Suivi des envois programmés
          {data && data.totals.forgotten > 0 && (
            <StatusBadge tone="danger" strong>
              {data.totals.forgotten} oublié{data.totals.forgotten > 1 ? 's' : ''}
            </StatusBadge>
          )}
        </button>
      </h2>
      {open && (
        <div id="sched-body" className="sched__body">
          {scheduling.isPending && (
            <p className="contact__state" role="status">
              <SpinnerIcon size={18} className="btn__spinner" />
              Chargement du suivi…
            </p>
          )}
          {scheduling.isError && (
            <div className="contact__state contact__state--error" role="alert">
              <AlertIcon size={18} />
              Suivi indisponible ({scheduling.error.message}).
              <Button size="sm" onClick={() => void scheduling.refetch()}>
                Réessayer
              </Button>
            </div>
          )}
          {data && (
            <>
              <div className="sched-tiles">
                <Tile
                  tone="ok"
                  value={data.totals.scheduled}
                  label="Programmés"
                  hint="partiront à la date choisie"
                  selected={selection === 'scheduled'}
                  onSelect={() => {
                    toggleSelection('scheduled')
                  }}
                />
                <Tile
                  tone="todo"
                  value={data.totals.validated}
                  label="Validés"
                  hint="à programmer"
                  selected={selection === 'validated'}
                  onSelect={() => {
                    toggleSelection('validated')
                  }}
                />
                <Tile
                  tone="idle"
                  value={data.totals.drafts}
                  label="Brouillons"
                  hint="à relire et valider"
                  selected={selection === 'drafts'}
                  onSelect={() => {
                    toggleSelection('drafts')
                  }}
                />
                <Tile
                  tone={data.totals.forgotten > 0 ? 'alert' : 'ok'}
                  value={data.totals.forgotten}
                  label="Oubliés"
                  hint="à envoyer cette semaine, non programmés"
                  selected={selection === 'forgotten'}
                  onSelect={() => {
                    toggleSelection('forgotten')
                  }}
                />
              </div>
              {(data.totals.scheduled_past > 0 ||
                data.totals.scheduled_with_error > 0 ||
                data.totals.scheduled_with_draft_error > 0) && (
                <p className="settings-connection__error" role="alert">
                  <AlertIcon size={16} />
                  <span>
                    {data.totals.scheduled_past > 0 &&
                      `${String(data.totals.scheduled_past)} programmé(s) dont l’heure est passée sans envoi. `}
                    {data.totals.scheduled_with_error > 0 &&
                      `${String(data.totals.scheduled_with_error)} programmé(s) en erreur d’envoi. `}
                    {data.totals.scheduled_with_draft_error > 0 &&
                      `${String(data.totals.scheduled_with_draft_error)} programmé(s) dont le brouillon Infomaniak n’a pas pu être créé (rien n’est parti).`}
                  </span>
                  {data.totals.scheduled_with_draft_error > 0 && (
                    <Link className="btn btn--secondary btn--sm" to={CONNECTIONS_PATH}>
                      Corriger la connexion Toolbox
                    </Link>
                  )}
                </p>
              )}
              {/* Nothing is listed until a tile is chosen: the list of the forgotten opens with its tile. */}
              {selection !== null && stepFilter !== null && (
                <p className="sched-filter">
                  Étape : {data.steps.find((step) => step.step === stepFilter)?.step_label ?? stepFilter}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setStepFilter(null)
                    }}
                  >
                    Toutes les étapes
                  </Button>
                </p>
              )}
              <DaysChart data={data} />
              <StepsTable data={data} selection={selection} stepFilter={stepFilter} onPick={pickStep} />
              {/* The list opens right under the table whose count was clicked, and is scrolled to. */}
              <div ref={listRef}>
                {selection === 'forgotten' && <Forgotten data={data} openHref={openHref} step={stepFilter} />}
                {selection !== null && selection !== 'forgotten' && (
                  <Prepared data={data} selection={selection} openHref={openHref} step={stepFilter} />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
