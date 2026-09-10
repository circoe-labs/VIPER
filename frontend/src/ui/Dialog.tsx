import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

import { IconButton } from './Button'
import { CloseIcon } from './icons'
import './dialog.css'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface DialogProps {
  open: boolean
  // Called on Esc, backdrop click and the close button. Guard unsaved changes here.
  onClose: () => void
  title: string
  description?: ReactNode
  footer?: ReactNode
  // Element focused on open (e.g. the first field of an editor); defaults to the dialog itself.
  initialFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}

// Open dialogs, the last opened on top (a dialog opened from inside another one opens after it).
const openDialogs: HTMLElement[] = []

export type ModalProps = DialogProps & { size?: 'sm' | 'md' | 'lg' }
export type DrawerProps = DialogProps & { size?: 'md' | 'lg' | 'xl' }

// Centered dialog for short confirmations and focused forms.
export function Modal({ open, size = 'md', ...props }: ModalProps) {
  return open ? <OpenDialog kind="modal" size={size} {...props} /> : null
}

// Right-hand panel for editors that must keep the underlying list/queue in context (Prospect, Company editors).
export function Drawer({ open, size = 'lg', ...props }: DrawerProps) {
  return open ? <OpenDialog kind="drawer" size={size} {...props} /> : null
}

function OpenDialog({
  kind,
  size,
  onClose,
  title,
  description,
  footer,
  initialFocusRef,
  children,
}: Omit<DialogProps, 'open'> & { kind: 'modal' | 'drawer'; size: string }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const previouslyFocused = document.activeElement
    ;(initialFocusRef?.current ?? dialogRef.current)?.focus()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus()
    }
  }, [initialFocusRef])

  // Focus must stay inside the top dialog. A focused control that gets disabled (a save button while saving) or
  // removed drops it to <body>, where neither Esc nor the Tab trap reach the dialog: the dialog takes it back. Should
  // focus still end up outside every dialog, Esc closes the top one.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    openDialogs.push(dialog)
    const isTop = () => openDialogs.at(-1) === dialog
    const observer = new MutationObserver(() => {
      const active = document.activeElement
      const lost = active === null || active === document.body || (dialog.contains(active) && active.matches(':disabled'))
      if (lost && isTop()) dialog.focus()
    })
    observer.observe(dialog, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] })
    function closeOnStrayEscape(event: globalThis.KeyboardEvent) {
      const target = event.target instanceof Node ? event.target : null
      const outside = !openDialogs.some((open) => open.contains(target))
      if (event.key === 'Escape' && !event.defaultPrevented && outside && isTop()) onCloseRef.current()
    }
    document.addEventListener('keydown', closeOnStrayEscape)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', closeOnStrayEscape)
      openDialogs.splice(openDialogs.indexOf(dialog), 1)
    }
  }, [])

  // Events stop here so a dialog opened from inside another one (portal events bubble through React) closes alone.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    const dialog = dialogRef.current
    if (event.key !== 'Tab' || !dialog) return
    event.stopPropagation()
    const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = focusables[0]
    const last = focusables.at(-1)
    const active = document.activeElement
    if (!first || !last) {
      event.preventDefault()
    } else if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className={`dialog-layer dialog-layer--${kind}`}>
      <div className="dialog-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`dialog dialog--${kind} dialog--${size}`}
        onKeyDown={handleKeyDown}
      >
        <header className="dialog__header">
          <div className="dialog__heading">
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="dialog__description">
                {description}
              </p>
            )}
          </div>
          <IconButton icon={CloseIcon} label="Fermer" onClick={onClose} />
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
