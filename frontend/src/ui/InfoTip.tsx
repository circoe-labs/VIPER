import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { type IconComponent, InfoIcon } from './icons'
import './info-tip.css'

const GAP = 6
const MARGIN = 8

interface InfoTipProps {
  // The explanation, shown on hover or keyboard focus (and read by assistive tech through aria-describedby).
  children: ReactNode
  // Accessible name of the trigger, e.g. « Aide : Agent ».
  label: string
  icon?: IconComponent
  size?: number
}

// A small « i » that explains on hover/focus instead of a paragraph of plain text. The bubble is portalled with a
// fixed position so a scrolling dialog body never clips it; the text also lives in a visually hidden node the
// trigger points at, so it is announced and testable without hovering.
export function InfoTip({ children, label, icon: Icon = InfoIcon, size = 16 }: InfoTipProps) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const { width, height } = bubble.current.getBoundingClientRect()
    const centred = anchor.left + anchor.width / 2 - width / 2
    const below = anchor.bottom + GAP
    setPosition({
      left: Math.max(MARGIN, Math.min(centred, window.innerWidth - width - MARGIN)),
      top: below + height > window.innerHeight - MARGIN ? anchor.top - GAP - height : below,
    })
  }, [open])

  const show = () => {
    setOpen(true)
  }
  const hide = () => {
    setOpen(false)
    setPosition(null)
  }

  return (
    <span className="info-tip">
      <button
        ref={trigger}
        type="button"
        className="info-tip__trigger"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hide()
        }}
        onClick={(event) => {
          // Inside a link or a label the « i » only explains: it never navigates nor toggles.
          event.preventDefault()
          event.stopPropagation()
          show()
        }}
      >
        <Icon size={size} />
      </button>
      <span id={id} className="visually-hidden">
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubble}
            className="info-tip__bubble"
            aria-hidden="true"
            style={position ? { left: position.left, top: position.top } : { visibility: 'hidden', left: 0, top: 0 }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}
