import type { Lifecycle } from '../api/lifecycle'
import { formatDay } from '../prospection/labels'
import { LifecycleBadge } from './LifecycleBadge'
import './lifecycle.css'

// The open reasons a record is out of prospecting, each with who, when and why.
export function LifecycleSummary({ state }: { state: Lifecycle }) {
  const departed = state.block === 'prospect_departed' || state.departure_reason !== null
  return (
    <ul className="lifecycle-summary">
      {state.block === 'prospect_do_not_contact' && (
        <li><LifecycleBadge block="prospect_do_not_contact" /></li>
      )}
      {departed && (
        <li><LifecycleBadge block="prospect_departed" departure={state.departure_reason} /></li>
      )}
      {state.holds.map((hold) => (
        <li key={`${hold.scope}-${hold.kind}`}>
          <LifecycleBadge block={`${hold.scope}_${hold.kind === 'archive' ? 'archived' : 'excluded'}`} />
          {hold.reason && <span>{hold.reason}</span>}
          <span className="lifecycle-summary__who">{hold.placed_by} · {formatDay(hold.placed_at)}</span>
        </li>
      ))}
    </ul>
  )
}
