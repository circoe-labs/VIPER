import { type ReactNode, useState } from 'react'

import { type IconComponent, SpinnerIcon } from '../ui/icons'
import { Popover } from '../ui/Popover'

export type SignalTone = 'ok' | 'info' | 'warning' | 'danger' | 'progress' | 'muted'

// One thing the editor has to say (a status, a warning, an outcome, a refusal): shown as a compact icon, its detail in a
// popover on click — never as a paragraph above the mail.
export interface Signal {
  id: string
  tone: SignalTone
  icon: IconComponent
  // Accessible name and hover tooltip: the short version of the detail.
  label: string
  detail: ReactNode
  // The detail is announced at once when the popover opens (refusals).
  alert?: boolean
}

function SignalChip({
  signal,
  open,
  onToggle,
  onClose,
}: {
  signal: Signal
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const { icon: Icon, tone, label } = signal
  return (
    <>
      <button
        ref={setAnchor}
        data-signal={signal.id}
        type="button"
        className={`mail-signal mail-signal--${tone}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        {tone === 'progress' ? <SpinnerIcon size={16} className="btn__spinner" /> : <Icon size={16} />}
      </button>
      {open && anchor && (
        <Popover anchor={anchor} label={label} onClose={onClose} alignRight className="mail-popover">
          <div role={signal.alert ? 'alert' : undefined} className="mail-popover__body">
            {signal.detail}
          </div>
        </Popover>
      )}
    </>
  )
}

interface MailSignalsProps {
  signals: Signal[]
  // The popover open now (one at a time, shared with the editor's other popovers), or null.
  openId: string | null
  onOpen: (id: string | null) => void
}

// The strip of icons of the toolbar. Every icon opens its own detail; Esc, an outside press or a second click closes it.
export function MailSignals({ signals, openId, onOpen }: MailSignalsProps) {
  if (signals.length === 0) return null
  return (
    <div className="mail-signals" role="group" aria-label="État du message">
      {signals.map((signal) => (
        <SignalChip
          key={signal.id}
          signal={signal}
          open={openId === signal.id}
          onToggle={() => {
            onOpen(openId === signal.id ? null : signal.id)
          }}
          onClose={() => {
            onOpen(null)
          }}
        />
      ))}
    </div>
  )
}
