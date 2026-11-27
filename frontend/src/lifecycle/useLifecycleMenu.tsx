import { useState } from 'react'

import type { LifecycleSubject } from '../api/lifecycle'
import { ArchiveIcon, PauseIcon } from '../ui/icons'
import type { MenuItem } from '../ui/Menu'
import { LifecycleDialog } from './LifecycleDialog'

// The two lifecycle entries of a row menu (or a sheet menu) and the dialog they open.
//   const lifecycle = useLifecycleMenu()
//   items: [...lifecycle.items(subject)]   … and render {lifecycle.dialog}
export function useLifecycleMenu(onChanged?: () => void) {
  const [open, setOpen] = useState<{ subject: LifecycleSubject; intent: 'status' | 'archive' } | null>(null)
  const items = (subject: LifecycleSubject): MenuItem[] => [
    { id: 'lifecycle-status', label: 'Changer de statut…', icon: PauseIcon, onSelect: () => { setOpen({ subject, intent: 'status' }) } },
    { id: 'lifecycle-archive', label: 'Archiver…', icon: ArchiveIcon, onSelect: () => { setOpen({ subject, intent: 'archive' }) } },
  ]
  const dialog = open ? (
    <LifecycleDialog subject={open.subject} intent={open.intent} onChanged={onChanged} onClose={() => { setOpen(null) }} />
  ) : null
  return { items, dialog, open: (subject: LifecycleSubject, intent: 'status' | 'archive' = 'status') => { setOpen({ subject, intent }) } }
}
