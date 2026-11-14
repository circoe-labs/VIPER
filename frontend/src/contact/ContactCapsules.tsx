import { AlertIcon, CalendarIcon, CheckCircleIcon, ClockIcon, type IconComponent, MailIcon, RepeatIcon, UsersIcon } from '../ui/icons'
import { KpiCard, type KpiTone, KpiGrid } from '../ui/KpiCard'
import { type Capsule, type ContactViewKey, VIEW_META } from './commercialModel'
import { contactHref } from './criteria'

interface ContactCapsulesProps {
  capsules: Capsule[]
  active: ContactViewKey
  loading: boolean
  error: boolean
  onRetry: () => void
}

const ICONS: Record<ContactViewKey, IconComponent> = {
  to_contact: MailIcon,
  follow_ups: RepeatIcon,
  overdue: ClockIcon,
  contacted: CheckCircleIcon,
  responses: UsersIcon,
  appointments: CalendarIcon,
  mail_errors: AlertIcon,
}

// The tone only colours what asks something (late, errors) or is good (replies, appointments); the rest stays green.
const TONES: Record<Capsule['tone'], KpiTone> = { info: 'default', neutral: 'default', warning: 'warning', danger: 'danger', success: 'success' }

// One capsule = one list: the figure is the list's size, the click opens the list (and the URL says which). They are the
// shared KpiCards, like the Prospection counters.
export function ContactCapsules({ capsules, active, loading, error, onRetry }: ContactCapsulesProps) {
  return (
    <nav className="contact-capsules" aria-label="Suivi commercial">
      <KpiGrid columns={4} label="Compteurs de contact">
        {capsules.map((capsule) => (
          <KpiCard
            key={capsule.key}
            label={capsule.label}
            icon={ICONS[capsule.key]}
            value={capsule.count}
            note={capsule.hint}
            hint={VIEW_META[capsule.key].title}
            tone={TONES[capsule.tone]}
            active={capsule.key === active}
            to={contactHref({ view: capsule.key })}
          />
        ))}
      </KpiGrid>
      {loading && <p className="contact-capsules__state" role="status">Chargement des compteurs…</p>}
      {error && (
        <p className="contact-capsules__state" role="alert">
          Compteurs indisponibles. <button type="button" className="contact-capsules__retry" onClick={onRetry}>Réessayer</button>
        </p>
      )}
    </nav>
  )
}
