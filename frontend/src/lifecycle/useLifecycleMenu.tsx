import { useContext, useState } from 'react'

import type { LifecycleSubject } from '../api/lifecycle'
import { ArchiveIcon, PauseIcon } from '../ui/icons'
import type { MenuItem } from '../ui/Menu'
import { type LifecycleRequest, LifecycleHostContext } from './host'
import { LifecycleDialog } from './LifecycleDialog'

// The two lifecycle entries of a row menu (or a sheet menu) and the dialog they open.
//   const lifecycle = useLifecycleMenu()
//   items: [...lifecycle.items(subject)]   … and render {lifecycle.dialog}
// Under a `LifecycleProvider` (the application shell) the dialog is held there and `dialog` is null; a component
// rendered on its own holds it itself.
export function useLifecycleMenu(onChanged?: () => void) {
  const host = useContext(LifecycleHostContext)
  const [local, setLocal] = useState<LifecycleRequest | null>(null)
  const open = (subject: LifecycleSubject, intent: 'status' | 'archive' = 'status') => {
    ;(host ?? setLocal)({ subject, intent, onChanged })
  }
  const items = (subject: LifecycleSubject): MenuItem[] => [
    { id: 'lifecycle-status', label: 'Changer de statut…', icon: PauseIcon, onSelect: () => { open(subject, 'status') } },
    { id: 'lifecycle-archive', label: 'Archiver…', icon: ArchiveIcon, onSelect: () => { open(subject, 'archive') } },
  ]
  const dialog = local ? (
    <LifecycleDialog subject={local.subject} intent={local.intent} onChanged={local.onChanged} onClose={() => { setLocal(null) }} />
  ) : null
  return { items, dialog, open }
}
