import { useState } from 'react'

import { StatusBadge } from '../../ui/Badge'
import { Modal } from '../../ui/Dialog'
import { InfoTip } from '../../ui/InfoTip'
import { Tabs } from '../../ui/Tabs'
import { type Connection, ConnectionFooterProvider, ConnectionNavProvider, ConnectionTabProvider } from './connection'
import './connections.css'

interface Props {
  connection: Connection
  onClose: () => void
  tab?: string
}

// The large centred edit window of one connection: sub-tabs when the service has several concerns, a footer that
// holds every action. Esc, a click outside and the focus trap come from the shared Modal.
export function ConnectionDialog({ connection, onClose, tab = connection.initialTab }: Props) {
  const { Logo, tabs } = connection
  const [selected, setSelected] = useState(tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id ?? '')
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  const current = tabs.some((t) => t.id === selected) ? selected : (tabs[0]?.id ?? '')
  const content = <ConnectionTabProvider value={current}>{connection.body}</ConnectionTabProvider>
  return (
    <ConnectionFooterProvider value={footer}>
      <ConnectionNavProvider value={setSelected}>
        <Modal
          open
          size="xl"
          className="conn-dialog"
          title={connection.title}
          titleIcon={<Logo size={28} />}
          headerActions={
            <>
              <StatusBadge tone={connection.badge.tone}>{connection.badge.label}</StatusBadge>
              <InfoTip label={`Aide : ${connection.title}`}>{connection.about}</InfoTip>
            </>
          }
          footer={<div ref={setFooter} className="conn-footer" />}
          onClose={onClose}
        >
          {tabs.length > 1 ? (
            <Tabs
              label={`Sections de ${connection.title}`}
              tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
              selected={current}
              onSelect={setSelected}
              className="conn-tabs"
            >
              {content}
            </Tabs>
          ) : (
            content
          )}
        </Modal>
      </ConnectionNavProvider>
    </ConnectionFooterProvider>
  )
}
