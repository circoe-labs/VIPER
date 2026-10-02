import type { KeyboardEvent } from 'react'
import { Link } from 'react-router'

import type { ProspectRow } from '../api/prospection'
import { StatusBadge } from '../ui/Badge'
import { BanIcon, BuildingIcon, ClockIcon, MinusCircleIcon, UsersIcon } from '../ui/icons'
import { CohortBadge, DueBadge, EmailErrorBadge, LevelBadge, StateBadge } from './ContactBadges'
import {
  ACTIVITY_LABELS,
  civilityLabel,
  formatDay,
  formatPhone,
  personName,
  stepLabel,
  TO_VERIFY,
} from './labels'

interface ProspectListProps {
  rows: ProspectRow[]
  // URL (search part) that opens a prospect: the current list URL plus `prospect=<id>`.
  openHref: (id: string) => string
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

// D12: a missing value is shown « À vérifier » (stored empty, never written by the UI).
function ToVerify({ what }: { what: string }) {
  return (
    <StatusBadge tone="warning">
      {what} : {TO_VERIFY}
    </StatusBadge>
  )
}

function EmailLine({ row }: { row: ProspectRow }) {
  if (!row.primary_email) return <ToVerify what="E-mail" />
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

function PhoneLine({ row }: { row: ProspectRow }) {
  if (row.primary_phone) return <span className="prospect-row__muted">{formatPhone(row.primary_phone)}</span>
  // Without a phone, an e-mail is another channel: nothing to verify.
  return row.primary_email ? null : <ToVerify what="Téléphone" />
}

// The step to send next and when (derived from the cohort and the real sends): « R1 à envoyer depuis le 14 sept. »
// once due, « … le 21 sept. » before.
function nextSend(row: ProspectRow): string | null {
  if (!row.next_due_at || !row.next_step) return null
  return `${stepLabel(row.next_step)} à envoyer ${row.due ? 'depuis le' : 'le'} ${formatDay(row.next_due_at)}`
}

// The contact follow-up: the cohort (or « Non validé »), the level reached by the real sends, the commercial state
// (none while « En séquence ») and what takes the person out of the automatic actions, then the next send, the dates
// and the referent (sequences rework D1-D9).
function Tracking({ row }: { row: ProspectRow }) {
  const inCampaign = row.cohort_code !== null && row.cohort_code !== 'S0'
  const next = nextSend(row)
  return (
    <>
      <span className="prospect-row__stage">
        <CohortBadge code={row.cohort_code} />
        {inCampaign && <LevelBadge level={row.level} />}
        <StateBadge status={row.tracking_status} />
        {row.email_error && <EmailErrorBadge />}
        {row.due && <DueBadge />}
      </span>
      {next && <span>{next}</span>}
      {row.response_received_at && <span>Réponse le {formatDay(row.response_received_at)}</span>}
      {row.appointment_at && <span>Rendez-vous le {formatDay(row.appointment_at)}</span>}
      {row.referent_name && <span className="prospect-row__muted">Référent : {row.referent_name}</span>}
    </>
  )
}

// The people list: one readable card per person — identity with its states, company and contacts, contact follow-up.
// The name is the row's link — the whole card is clickable — and opens the prospect (prospectEditor.tsx).
export function ProspectList({ rows, openHref }: ProspectListProps) {
  return (
    <>
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
                    {title.length > 0 && <span>{title.join(' · ')}</span>}
                    {!row.exact_job_title && <ToVerify what="Fonction" />}
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
                <PhoneLine row={row} />
              </div>
              <div className="prospect-row__tracking">
                <Tracking row={row} />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
