import { type MouseEvent, type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '../../ui/Button'
import type { Point } from '../../ui/floating'
import { MailIcon } from '../../ui/icons'
import { Menu } from '../../ui/Menu'

// « Contacter » reuses the Contact workbench deep link (`/contact?prospect=<id>`, contact/criteria.ts): no second flow.
export function contactHref(prospectId: string): string {
  return `/contact?prospect=${encodeURIComponent(prospectId)}`
}

interface ActionProps {
  prospectId: string
  // Not contactable (« Ne pas contacter »): the action stays visible, disabled, with the reason as tooltip.
  disabledReason?: string | null
  className?: string
}

export function useContactAction(prospectId: string) {
  const navigate = useNavigate()
  return () => {
    void navigate(contactHref(prospectId))
  }
}

// Explicit, keyboard-accessible equivalent of the context menu entry (the right click is never the only way).
export function ProspectContactButton({ prospectId, disabledReason, className }: ActionProps) {
  const contact = useContactAction(prospectId)
  return (
    <Button
      variant="secondary"
      icon={MailIcon}
      className={className}
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? undefined}
      onClick={contact}
    >
      Contacter
    </Button>
  )
}

interface SurfaceProps extends ActionProps {
  children: ReactNode
}

// Wrap the prospect sheet: right click (or the context-menu key) on its surface offers « Contacter ». Links, buttons
// and fields keep the browser's own menu. Pair it with <ProspectContactButton> in the header.
export function ProspectContextMenuSurface({ prospectId, disabledReason, className, children }: SurfaceProps) {
  const [position, setPosition] = useState<Point | null>(null)
  const contact = useContactAction(prospectId)
  const onContextMenu = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, [contenteditable="true"]')) return
    event.preventDefault()
    setPosition({ x: event.clientX, y: event.clientY })
  }
  return (
    <div className={className} onContextMenu={onContextMenu}>
      {children}
      {position && (
        <Menu
          label="Actions du prospect"
          position={position}
          sections={[
            {
              items: [
                {
                  id: 'contact',
                  label: 'Contacter',
                  icon: MailIcon,
                  disabled: Boolean(disabledReason),
                  title: disabledReason ?? undefined,
                  onSelect: contact,
                },
              ],
            },
          ]}
          onClose={() => {
            setPosition(null)
          }}
        />
      )}
    </div>
  )
}
