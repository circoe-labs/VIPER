import { Link } from 'react-router'

import { type Capsule, type ContactViewKey } from './commercialModel'
import { contactHref } from './criteria'

const NUMBER = new Intl.NumberFormat('fr-FR')

interface ContactCapsulesProps {
  capsules: Capsule[]
  active: ContactViewKey
  loading: boolean
  error: boolean
  onRetry: () => void
}

// One capsule = one list: the figure is the list's size, the click opens the list (and the URL says which).
export function ContactCapsules({ capsules, active, loading, error, onRetry }: ContactCapsulesProps) {
  return (
    <nav className="contact-capsules" aria-label="Suivi commercial">
      <ul className="contact-capsules__list">
        {capsules.map((capsule) => (
          <li key={capsule.key}>
            <Link
              className={`contact-capsule contact-capsule--${capsule.tone}`}
              to={contactHref({ view: capsule.key })}
              aria-current={capsule.key === active ? 'page' : undefined}
            >
              <span className="contact-capsule__label">{capsule.label}</span>
              <strong className="contact-capsule__count">
                {capsule.count === null ? '—' : NUMBER.format(capsule.count)}
                {capsule.count === null && <span className="visually-hidden"> indisponible</span>}
              </strong>
              {capsule.hint && <span className="contact-capsule__hint">{capsule.hint}</span>}
            </Link>
          </li>
        ))}
      </ul>
      {loading && <p className="contact-capsules__state" role="status">Chargement des compteurs…</p>}
      {error && (
        <p className="contact-capsules__state" role="alert">
          Compteurs indisponibles. <button type="button" className="contact-capsules__retry" onClick={onRetry}>Réessayer</button>
        </p>
      )}
    </nav>
  )
}
