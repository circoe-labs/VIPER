import type { Counters, Segment } from '../api/prospection'
import { ChevronRightIcon } from '../ui/icons'
import { SEGMENT_INFO } from './labels'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ITEMS: { segment: Segment; label: string; caption: string }[] = [
  { segment: 'to_contact', label: 'Premier contact à envoyer', caption: 'Dans une campagne, hors oppositions et inactifs' },
  { segment: 'due', label: 'Contacts et relances échus', caption: 'Échéance arrivée ou dépassée' },
  { segment: 'no_response', label: 'En attente de réponse', caption: 'Au moins un envoi, séquence en cours' },
  { segment: 'responses', label: 'Réponses reçues', caption: 'Inclut les prospects avec un RDV' },
  { segment: 'appointments', label: 'RDV pris', caption: 'Statut ou date de rendez-vous enregistré' },
  { segment: 'email_error', label: 'Erreurs d’envoi à traiter', caption: 'Adresse à corriger pour reprendre le suivi' },
]

export function ContactActivity({ counters, active, onSelect }: { counters: Counters | undefined; active: Segment; onSelect: (segment: Segment) => void }) {
  return <section className="contact-activity" aria-labelledby="contact-activity-title">
    <div className="prospection-section__head"><h2 id="contact-activity-title">Suivi commercial</h2><span>Selon la recherche et les filtres</span></div>
    <div className="contact-activity__grid">
      {ITEMS.map(({ segment, label, caption }) => {
        const Icon = SEGMENT_INFO[segment].icon
        return <button key={segment} type="button" className="contact-activity__item" aria-pressed={active === segment} onClick={() => { onSelect(active === segment ? 'all' : segment) }} title={SEGMENT_INFO[segment].hint}>
          <Icon size={18} /><span><span className="contact-activity__label">{label}</span><span className="contact-activity__caption">{caption}</span></span><strong>{counters ? NUMBER.format(counters.counts[segment]) : '…'}</strong><ChevronRightIcon size={15} />
        </button>
      })}
    </div>
    <p className="prospection-section__hint">Ces indicateurs peuvent se recouper : un prospect peut, par exemple, avoir répondu et pris un RDV. Ils ne s’additionnent pas.</p>
  </section>
}
