import { useState } from 'react'

import { StatusBadge } from '../../ui/Badge'
import { IconButton } from '../../ui/Button'
import { PlayIcon } from '../../ui/icons'
import { Tooltip } from '../../ui/Tooltip'
import type { Connection, TestOutcome } from './connection'
import './connections.css'

// One tile of the grid: ALWAYS the same size, only the essentials — logo, title, which account/model, a status badge
// and the quick test. Clicking the tile opens its edit dialog.
export function ConnectionTile({ connection, onOpen }: { connection: Connection; onOpen: () => void }) {
  const { Logo, quickTest } = connection
  // The last quick test, kept while the connection's own state is unchanged.
  const [outcome, setOutcome] = useState<(TestOutcome & { base: string }) | null>(null)
  const fresh = outcome && outcome.base === connection.badge.label ? outcome : null
  const shown = fresh ?? connection.badge

  async function test() {
    if (!quickTest) return
    setOutcome(null)
    const result = await quickTest.run()
    if (result) setOutcome({ ...result, base: connection.badge.label })
  }

  return (
    <article className="conn-tile" aria-label={connection.title}>
      <button type="button" className="conn-tile__open" aria-label={`Configurer ${connection.title}`} onClick={onOpen}>
        <span className="conn-tile__logo">
          <Logo size={32} />
        </span>
        <span className="conn-tile__text">
          <span className="conn-tile__title">{connection.title}</span>
          <span className="conn-tile__summary" title={connection.summary}>
            {connection.summary}
          </span>
        </span>
      </button>
      <div className="conn-tile__foot">
        <Tooltip content={fresh?.detail ?? shown.label} focusable>
          <StatusBadge tone={shown.tone}>{shown.label}</StatusBadge>
        </Tooltip>
        {quickTest && (
          <IconButton
            icon={PlayIcon}
            size="sm"
            variant="secondary"
            label={quickTest.pending ? `${quickTest.label}…` : quickTest.label}
            loading={quickTest.pending}
            disabled={quickTest.disabled}
            title={quickTest.disabled ? quickTest.disabledReason : quickTest.label}
            onClick={() => void test()}
          />
        )}
      </div>
    </article>
  )
}
