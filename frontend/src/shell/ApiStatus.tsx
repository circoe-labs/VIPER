import { useHealth } from '../api/health'

export function ApiStatus() {
  const health = useHealth()
  const label = health.isPending ? 'vérification…' : health.isError ? 'indisponible' : 'connectée'
  return <p role="status">API : {label}</p>
}
