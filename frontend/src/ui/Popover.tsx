import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { useOutsidePress, useRestoreFocus, useViewportClamp } from './floating'
import './popover.css'

const GAP = 6

interface PopoverProps {
  // The element that opened the popover: placement reference, and presses on it do not count as "outside".
  anchor: HTMLElement
  // Accessible name of the popover dialog.
  label: string
  // Esc and outside press. Focus returns to the anchor.
  onClose: () => void
  // Align the popover's right edge with the anchor's (anchors near the right side of the screen).
  alignRight?: boolean
  children: ReactNode
}

// Small non-modal dialog anchored under a control (column filter editor, column chooser). Focus moves to its first
// field on open; Tab is not trapped, the page stays usable.
export function Popover({ anchor, label, onClose, alignRight = false, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const rect = anchor.getBoundingClientRect()
  const { x, y } = useViewportClamp(ref, { x: alignRight ? rect.right : rect.left, y: rect.bottom + GAP }, alignRight)
  useRestoreFocus()
  useOutsidePress(ref, onClose, anchor)

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(:disabled)')
    ;(first ?? ref.current)?.focus()
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="popover"
      style={{ left: x, top: y }}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    document.body,
  )
}
