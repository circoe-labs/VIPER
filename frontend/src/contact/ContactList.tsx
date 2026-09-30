import { type KeyboardEvent, useEffect, useRef } from 'react'
import { Link } from 'react-router'

import { type ContactRow, MESSAGE_STEPS } from '../api/contact'
import { NEXT_ACTION_STATES } from '../api/prospection'
import { parseIsoWeek, weeksFrom } from '../lib/isoWeek'
import { civilityLabel, personName } from '../prospection/labels'
import { StateBadge, WeekBadge } from '../prospection/TrackingBadges'
import { StatusBadge } from '../ui/Badge'
import { BuildingIcon, ClockIcon } from '../ui/icons'
import { FROM_LIST } from './criteria'
import { NEXT_STEP_LABELS, STEP_LABELS } from './labels'
import { MessageBadge } from './MessageBadge'

interface ContactListProps {
  rows: ContactRow[]
  // URL (search part) that opens a prospect in the workbench.
  openHref: (id: string) => string
  // Business day, `YYYY-MM-DD`.
  today: string
  // The prospect whose workbench was just closed: its link takes the focus back.
  returnedFrom: string | null
}

function initials(row: ContactRow): string {
  return [row.first_name, row.last_name].map((part) => part?.trim()[0] ?? '').join('').toUpperCase() || '?'
}

// ↑/↓ move between people, Home/End jump to the first/last one; Enter opens (native link).
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('.contact-row__open')]
  const index = links.findIndex((link) => link === document.activeElement)
  if (index < 0) return
  const target = { ArrowDown: Math.min(index + 1, links.length - 1), ArrowUp: Math.max(index - 1, 0), Home: 0, End: links.length - 1 }[
    event.key
  ]
  if (target === undefined) return
  event.preventDefault()
  links[target]?.focus()
}

// Past-week cue, display only: a state still waiting for its next action whose week is before the current one.
function overdue(row: ContactRow, today: string): boolean {
  const week = parseIsoWeek(row.next_action_week)
  return week !== null && NEXT_ACTION_STATES.includes(row.tracking_status) && weeksFrom(today, week) < 0
}

// The Contact list: one compact card per person, in the card language of Prospection — identity and company, the
// two independent indicators (state, next-action week) with what the week prepares, and the status of the three
// messages. The name is the card's link (the whole card is clickable) and opens the workbench.
export function ContactList({ rows, openHref, today, returnedFrom }: ContactListProps) {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!returnedFrom) return
    listRef.current?.querySelector<HTMLAnchorElement>(`[data-prospect="${CSS.escape(returnedFrom)}"]`)?.focus()
  }, [returnedFrom])

  return (
    <ul ref={listRef} className="contact-list" aria-label="Prospects à contacter" onKeyDown={moveFocus}>
      {rows.map((row) => {
        const civility = civilityLabel(row.civility)
        const week = parseIsoWeek(row.next_action_week)
        const title = [row.role_label, row.exact_job_title].filter(Boolean)
        return (
          <li key={row.id} className="contact-row">
            <div className="contact-row__identity">
              <span className="contact-row__avatar" aria-hidden="true">
                {initials(row)}
              </span>
              <div className="contact-row__who">
                <span className="contact-row__name-line">
                  {civility && <span className="contact-row__muted">{civility}</span>}
                  <Link className="contact-row__open" to={openHref(row.id)} state={FROM_LIST} data-prospect={row.id}>
                    {personName(row) || 'Nom non renseigné'}
                  </Link>
                </span>
                <span className="contact-row__muted contact-row__line">
                  {title.length > 0 ? title.join(' · ') : 'Rôle non renseigné'}
                </span>
                <span className="contact-row__company contact-row__line">
                  <BuildingIcon size={16} />
                  {row.company_name ?? <span className="contact-row__muted">Sans entreprise</span>}
                  {row.primary_email ? (
                    <span className="contact-row__muted contact-row__email" title={row.primary_email}>
                      · {row.primary_email}
                    </span>
                  ) : (
                    <StatusBadge tone="warning">Pas d’e-mail principal</StatusBadge>
                  )}
                </span>
              </div>
            </div>
            <div className="contact-row__tracking">
              <span className="contact-row__badges">
                <StateBadge status={row.tracking_status} />
                {week && <WeekBadge week={week} today={today} />}
                {overdue(row, today) && (
                  <StatusBadge tone="warning" icon={ClockIcon}>
                    Échu
                  </StatusBadge>
                )}
                {row.tracking_status === 'neutral' && !week && (
                  <span className="contact-row__muted">Aucun état · aucune semaine</span>
                )}
              </span>
              {row.next_step && (
                <span className="contact-row__next">
                  <span className="contact-row__muted">À préparer :</span> {NEXT_STEP_LABELS[row.next_step]}
                </span>
              )}
            </div>
            {MESSAGE_STEPS.every((step) => row.messages[step] === null) ? (
              <p className="contact-row__muted contact-row__no-message">Aucun message préparé</p>
            ) : (
              <dl className="contact-row__messages">
                {MESSAGE_STEPS.map((step) => {
                  const status = row.messages[step]
                  return (
                    <div key={step} className="contact-row__message">
                      <dt>{STEP_LABELS[step]}</dt>
                      <dd>{status ? <MessageBadge status={status} /> : <span className="contact-row__muted">Vide</span>}</dd>
                    </div>
                  )
                })}
              </dl>
            )}
          </li>
        )
      })}
    </ul>
  )
}
