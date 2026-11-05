import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { ContactRow } from '../api/contact'
import { StateBadge } from '../prospection/ContactBadges'
import { personName } from '../prospection/labels'
import { IconButton } from '../ui/Button'
import { ChevronDownIcon, MailIcon, MoreIcon } from '../ui/icons'
import { Menu } from '../ui/Menu'
import type { Point } from '../ui/floating'
import { ContactDetails } from './ContactDetails'
import { FROM_LIST } from './criteria'
import { stepLabel } from './labels'

interface ContactListProps {
  rows: ContactRow[]
  openHref: (id: string) => string
  today: string
  returnedFrom: string | null
}

function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('.contact-row__open')]
  const index = links.findIndex((link) => link === document.activeElement)
  if (index < 0) return
  const target = { ArrowDown: Math.min(index + 1, links.length - 1), ArrowUp: Math.max(index - 1, 0), Home: 0, End: links.length - 1 }[event.key]
  if (target === undefined) return
  event.preventDefault()
  links[target]?.focus()
}

const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })

function ContactLine({ row, href }: { row: ContactRow; href: string }) {
  const [expanded, setExpanded] = useState(false)
  const [menu, setMenu] = useState<Point | null>(null)
  const navigate = useNavigate()
  const name = personName(row) || 'Nom non renseigné'
  const initials = [row.first_name, row.last_name].map((part) => part?.trim()[0] ?? '').join('').toUpperCase() || '?'
  const lastEmail = row.last_email_sent_at
  const job = row.exact_job_title ?? row.role_label
  return (
    <li className="contacts-line">
      <div className="contacts-line__summary">
        <IconButton icon={ChevronDownIcon} size="sm" className="contacts-line__expand" label={`Détails de ${name}`} aria-expanded={expanded} aria-controls={`contact-details-${row.id}`} onClick={() => { setExpanded(!expanded) }} />
        <span className="contacts-line__avatar" aria-hidden="true">{initials}</span>
        <div className="contacts-line__identity">
          <Link className="contact-row__open" data-prospect={row.id} to={href} state={FROM_LIST}>{name}</Link>
          <span title={[job, row.company_name].filter(Boolean).join(' · ')}>{[job, row.company_name].filter(Boolean).join(' · ') || 'Informations à compléter'}</span>
        </div>
        <div className="contacts-line__stage">
          {row.tracking_status !== 'neutral' ? <StateBadge status={row.tracking_status} /> : (
            <span className={`contacts-stage${row.due && row.next_step ? ' contacts-stage--due' : ''}`}>
              {row.due && row.next_step ? `À préparer : ${row.next_step === 'contact' ? 'Contact' : `Relance ${stepLabel(row.next_step)}`}` : 'Contacté'}
            </span>
          )}
        </div>
        <span className="contacts-line__channel" title="E-mail enregistré"><MailIcon size={18} /><span className="visually-hidden">E-mail</span></span>
        <div className="contacts-line__last">
          <span>Dernier e-mail envoyé</span>
          {lastEmail ? <time dateTime={lastEmail}>{DAY.format(new Date(lastEmail))}</time> : <span>Date non renseignée</span>}
        </div>
        <IconButton icon={MoreIcon} size="sm" label={`Actions de ${name}`} className="contacts-line__options" aria-haspopup="menu" onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          setMenu({ x: box.right, y: box.bottom })
        }} />
      </div>
      {expanded && <ContactDetails id={row.id} name={name} openHref={href} />}
      {menu && <Menu label={`Actions de ${name}`} position={menu} alignRight sections={[{ items: [
        { id: 'follow', label: 'Ouvrir le suivi', onSelect: () => { void navigate(href, { state: FROM_LIST }) } },
        { id: 'edit', label: 'Modifier le prospect', onSelect: () => { void navigate(`/prospection?prospect=${row.id}`) } },
        { id: 'details', label: expanded ? 'Replier les détails' : 'Afficher les détails', onSelect: () => { setExpanded(!expanded) } },
      ] }]} onClose={() => { setMenu(null) }} />}
    </li>
  )
}

export function ContactList({ rows, openHref, returnedFrom }: ContactListProps) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (returnedFrom) ref.current?.querySelector<HTMLAnchorElement>(`[data-prospect="${CSS.escape(returnedFrom)}"]`)?.focus()
  }, [returnedFrom])
  return <ul ref={ref} className="contacts-list" aria-label="Prospects contactés" onKeyDown={moveFocus}>
    {rows.map((row) => <ContactLine key={row.id} row={row} href={openHref(row.id)} />)}
  </ul>
}
