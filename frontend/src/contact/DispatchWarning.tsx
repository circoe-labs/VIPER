import type { AriaRole, ReactNode } from 'react'
import { Link } from 'react-router'

import type { DispatchReason } from '../api/contact'
import { StatusBadge } from '../ui/Badge'
import { AlertIcon } from '../ui/icons'
import { CONNECTIONS_PATH, reasonCopy } from './dispatchCopy'

interface DispatchWarningProps {
  reason: DispatchReason | null
  children: ReactNode
  // The badge « Ne partira pas : … » (the editor's status line); off for the page banner, whose text says it.
  badge?: boolean
  // `alert` for the Contact page banner; none where the warning is part of a panel's static content.
  role?: AriaRole
  className?: string
}

// « Ne partira pas » (Contact port S9): a scheduled message the server cannot send, the reason in plain words, and the
// link to the place that fixes it (Paramètres › Connexions). Warning tone of the DA (`contact-mail__banner`).
export function DispatchWarning({ reason, children, badge = false, role, className }: DispatchWarningProps) {
  const copy = reasonCopy(reason)
  return (
    <div className={['contact-mail__banner', 'contact-dispatch-warning', className].filter(Boolean).join(' ')} role={role}>
      {!badge && <AlertIcon size={16} />}
      <div className="contact-dispatch-warning__body">
        {badge && (
          <span>
            <StatusBadge tone="warning">{copy.badge}</StatusBadge>
          </span>
        )}
        <p>{children}</p>
        <Link className="btn btn--secondary btn--sm contact-dispatch-warning__link" to={CONNECTIONS_PATH}>
          {copy.link}
        </Link>
      </div>
    </div>
  )
}
