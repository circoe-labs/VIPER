import { useHealth } from '../api/health'
import { AlertIcon, CheckCircleIcon, ClockIcon, type IconComponent } from '../ui/icons'

type HealthState = 'pending' | 'down' | 'up'

const STATES: Record<HealthState, { label: string; icon: IconComponent }> = {
  pending: { label: 'vérification…', icon: ClockIcon },
  down: { label: 'indisponible', icon: AlertIcon },
  up: { label: 'connectée', icon: CheckCircleIcon },
}

// `compact` (collapsed sidebar) keeps the text for assistive technologies and as a tooltip.
export function ApiStatus({ compact = false }: { compact?: boolean }) {
  const health = useHealth()
  const state: HealthState = health.isPending ? 'pending' : health.isError ? 'down' : 'up'
  const { label, icon: Icon } = STATES[state]
  return (
    <p role="status" className="api-status" data-state={state} title={compact ? `API : ${label}` : undefined}>
      <Icon size={16} />
      <span className={compact ? 'visually-hidden' : undefined}>API : {label}</span>
    </p>
  )
}
