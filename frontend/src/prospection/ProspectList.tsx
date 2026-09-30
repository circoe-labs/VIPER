import { type KeyboardEvent, useState } from 'react'
import { Link } from 'react-router'

import { NEXT_ACTION_STATES, type ProspectRow } from '../api/prospection'
import { type IsoWeek, parseIsoWeek, weeksFrom } from '../lib/isoWeek'
import { StatusBadge } from '../ui/Badge'
import { BanIcon, BuildingIcon, ClockIcon, MinusCircleIcon, UsersIcon } from '../ui/icons'
import {
  ACTIVITY_LABELS,
  civilityLabel,
  formatDay,
  formatPhone,
  personName,
} from './labels'
import { PlanWeekButton } from './QuickWeekPlanner'
import { StateBadge, WeekBadge } from './TrackingBadges'

interface ProspectListProps {
  rows: ProspectRow[]
  // URL (search part) that opens a prospect: the current list URL plus `prospect=<id>`.
  openHref: (id: string) => string
  // Business day (`YYYY-MM-DD`): the current week and year of the week badges.
  today: string
  // Offer the quick week planning (PATCH) on each card.
  planning?: boolean
}

function initials(row: ProspectRow): string {
  return [row.first_name, row.last_name].map((part) => part?.trim()[0] ?? '').join('').toUpperCase() || '?'
}

// ↑/↓ move between people, Home/End jump to the first/last one; Enter opens (native link).
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('.prospect-row__open')]
  const index = links.findIndex((link) => link === document.activeElement)
  if (index < 0) return
  const target = {
    ArrowDown: Math.min(index + 1, links.length - 1),
    ArrowUp: Math.max(index - 1, 0),
    Home: 0,
    End: links.length - 1,
  }[event.key]
  if (target === undefined) return
  event.preventDefault()
  links[target]?.focus()
}

function Verification({ row }: { row: ProspectRow }) {
  const date = row.employment_verified_at ? formatDay(row.employment_verified_at) : null
  switch (row.verification_state) {
    case 'never_verified':
      return <StatusBadge tone="warning">Emploi jamais vérifié</StatusBadge>
    case 'stale':
      return (
        <StatusBadge tone="warning" icon={ClockIcon}>
          Vérifié le {date} · ancien
        </StatusBadge>
      )
    case 'channels_reset':
      return (
        <StatusBadge tone="warning" icon={ClockIcon}>
          Coordonnées à revérifier
        </StatusBadge>
      )
    case 'verified':
      return <StatusBadge tone="success">Vérifié le {date}</StatusBadge>
  }
}

function Activity({ row }: { row: ProspectRow }) {
  const label = ACTIVITY_LABELS[row.activity_status]
  if (row.activity_status === 'active') return <StatusBadge tone="info" icon={UsersIcon}>{label}</StatusBadge>
  if (row.activity_status === 'inactive') return <StatusBadge tone="neutral" icon={MinusCircleIcon}>{label}</StatusBadge>
  return <StatusBadge tone="neutral">{label}</StatusBadge>
}

function EmailLine({ row }: { row: ProspectRow }) {
  if (!row.primary_email) return <StatusBadge tone="warning">Pas d’e-mail principal</StatusBadge>
  return (
    <span className="prospect-row__channel">
      <span className="prospect-row__email" title={row.primary_email}>
        {row.primary_email}
      </span>
      {row.email_state === 'invalid' && <StatusBadge tone="danger">Invalide</StatusBadge>}
      {row.email_state === 'unverified' && <StatusBadge tone="warning">Non vérifié</StatusBadge>}
      {row.email_state === 'verified' && <StatusBadge tone="success">Vérifié</StatusBadge>}
    </span>
  )
}

// The contact follow-up: two independent indicators — the state (none while `neutral`) and the next-action week —
// then the dates and the referent (Contact decisions 4-5).
interface TrackingProps {
  row: ProspectRow
  today: string
  // Announces the outcome of a quick planning; null: no planning on the cards.
  onPlanned: ((notice: string) => void) | null
}

// Past-week cue, display only: a planned first contact due by the backend's segment (`due`), or a follow-up whose
// next-action week is before the current one (the `due` segment itself stays the first contacts).
function overdue(row: ProspectRow, week: IsoWeek | null, today: string): boolean {
  if (row.due) return true
  return week !== null && NEXT_ACTION_STATES.includes(row.tracking_status ?? 'neutral') && weeksFrom(today, week) < 0
}

function Tracking({ row, today, onPlanned }: TrackingProps) {
  const week = parseIsoWeek(row.planned_contact_week)
  const shown = row.tracking_status !== null && row.tracking_status !== 'neutral'
  return (
    <>
      <span className="prospect-row__stage">
        <StateBadge status={row.tracking_status} />
        {week && <WeekBadge week={week} today={today} />}
        {overdue(row, week, today) && (
          <StatusBadge tone="warning" icon={ClockIcon}>
            Échu
          </StatusBadge>
        )}
        {!shown && !week && <span className="prospect-row__muted">Aucun état · aucune semaine</span>}
      </span>
      {onPlanned && <PlanWeekButton row={row} onPlanned={onPlanned} />}
      {row.response_received_at && <span>Réponse le {formatDay(row.response_received_at)}</span>}
      {row.appointment_at && <span>Rendez-vous le {formatDay(row.appointment_at)}</span>}
      {row.referent_name && <span className="prospect-row__muted">Référent : {row.referent_name}</span>}
    </>
  )
}

// The people list: one readable card per person — identity with its states, company and contacts, contact follow-up.
// The name is the row's link — the whole card is clickable — and opens the prospect (prospectEditor.tsx).
export function ProspectList({ rows, openHref, today, planning = true }: ProspectListProps) {
  // One live region for the whole list: the outcome of the last quick planning.
  const [notice, setNotice] = useState('')
  const onPlanned = planning ? setNotice : null
  return (
    <>
      <p className="visually-hidden" role="status">
        {notice}
      </p>
      <ul className="prospect-list" aria-label="Prospects" onKeyDown={moveFocus}>
        {rows.map((row) => {
          const civility = civilityLabel(row.civility)
          const blocked = row.contactability_status === 'do_not_contact'
          const title = [row.role_label, row.exact_job_title].filter(Boolean)
          return (
            <li key={row.id} className={`prospect-row${blocked ? ' prospect-row--blocked' : ''}`}>
              <div className="prospect-row__identity">
                <span className="prospect-row__avatar" aria-hidden="true">
                  {initials(row)}
                </span>
                <div className="prospect-row__who">
                  <span className="prospect-row__name-line">
                    {civility && <span className="prospect-row__civility">{civility}</span>}
                    <Link className="prospect-row__open" to={openHref(row.id)}>
                      {personName(row)}
                    </Link>
                    {blocked && (
                      <StatusBadge tone="danger" icon={BanIcon}>
                        Ne pas contacter
                      </StatusBadge>
                    )}
                  </span>
                  <span className="prospect-row__title">
                    {title.length > 0 ? title.join(' · ') : <span className="prospect-row__muted">Rôle non renseigné</span>}
                  </span>
                  <span className="prospect-row__state">
                    <Activity row={row} />
                    <Verification row={row} />
                  </span>
                </div>
              </div>
              <div className="prospect-row__contact">
                <span className="prospect-row__company">
                  <BuildingIcon size={16} />
                  {row.company_name ?? <span className="prospect-row__muted">Sans entreprise</span>}
                </span>
                <EmailLine row={row} />
                {row.primary_phone && <span className="prospect-row__muted">{formatPhone(row.primary_phone)}</span>}
              </div>
              <div className="prospect-row__tracking">
                <Tracking row={row} today={today} onPlanned={onPlanned} />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
