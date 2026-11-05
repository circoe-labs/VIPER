import { Button } from './Button'
import './creation-period.css'

const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const format = (day: string) => DAY.format(new Date(`${day}T00:00:00Z`))

export function CreationPeriod({ start, end, onClear }: { start: string | null | undefined; end: string | null | undefined; onClear: () => void }) {
  if (!start && !end) return null
  return <div className="creation-period" role="group" aria-label="Filtre de date de création">
    <span>{start && end ? `Créés du ${format(start)} au ${format(end)}` : start ? `Créés depuis le ${format(start)}` : `Créés jusqu’au ${format(end ?? '')}`}</span>
    <Button size="sm" variant="ghost" onClick={onClear}>Retirer le filtre de création</Button>
  </div>
}
