import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import './info-tip.css'

const GAP = 6
const MARGIN = 8

interface TooltipProps {
  // The detail shown on hover (and keyboard focus when `focusable`); it also lives in a visually hidden node so
  // assistive technology and tests read it without hovering.
  content: ReactNode
  children: ReactNode
  className?: string
  // True when the anchor holds no focusable control of its own: it then takes the focus to show the detail.
  focusable?: boolean
}

// A hover/focus bubble around any inline content (the « i » of InfoTip is the same bubble around an icon button).
// Portalled with a fixed position so a card, a scroller or a dialog never clips it.
export function Tooltip({ content, children, className, focusable = false }: TooltipProps) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return
    const box = anchor.current.getBoundingClientRect()
    const { width, height } = bubble.current.getBoundingClientRect()
    const centred = box.left + box.width / 2 - width / 2
    const below = box.bottom + GAP
    setPosition({
      left: Math.max(MARGIN, Math.min(centred, window.innerWidth - width - MARGIN)),
      top: below + height > window.innerHeight - MARGIN ? box.top - GAP - height : below,
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
    <span
      ref={anchor}
      className={className}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide()
      }}
    >
      {children}
      <span id={id} className="visually-hidden">
        {content}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubble}
            className="info-tip__bubble"
            aria-hidden="true"
            style={position ? { left: position.left, top: position.top } : { visibility: 'hidden', left: 0, top: 0 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}
