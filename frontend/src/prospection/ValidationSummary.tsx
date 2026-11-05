import { useProspectionOverview } from '../api/prospection'
import { AlertIcon, BanIcon, CheckCircleIcon, ChevronRightIcon } from '../ui/icons'
import type { ProspectionView } from './criteria'

const NUMBER = new Intl.NumberFormat('fr-FR')
const GROUPS = [
  { key: 'employment_validated', label: 'Emploi validé', hint: 'Validation enregistrée dans VIPER', icon: CheckCircleIcon, patch: { validated_only: true, segment: 'all', review: null } },
  { key: 'employment_pending', label: 'Validation non enregistrée', hint: 'Fiches à examiner pour retrouver ou confirmer la validation', icon: AlertIcon, patch: { validated_only: false, segment: 'never_verified', review: 'to_verify' } },
  { key: 'ignored', label: 'Mis de côté', hint: 'Prospects ignorés, conservés dans la base', icon: BanIcon, patch: { validated_only: false, segment: 'all', review: 'ignored' } },
] as const

export function ValidationSummary({ onSelect }: { onSelect: (patch: Partial<ProspectionView>) => void }) {
  const query = useProspectionOverview()
  return <section className="validation-summary" aria-labelledby="validation-summary-title">
    <div className="prospection-section__head"><h2 id="validation-summary-title">Validation des prospects</h2><span>Statut de l’emploi · toute la base</span></div>
    <div className="validation-summary__groups">
      {GROUPS.map(({ key, label, hint, icon: Icon, patch }) => <button type="button" key={key} aria-label={query.data && !query.isError ? `${label} : ${NUMBER.format(query.data[key])}` : label} className={`validation-summary__group validation-summary__group--${key}`} onClick={() => { onSelect(patch) }}>
        <Icon size={20} /><span><span className="validation-summary__label">{label}</span><span className="validation-summary__hint">{hint}</span></span><strong>{query.isError ? 'Indisponible' : query.data ? NUMBER.format(query.data[key]) : '…'}</strong><ChevronRightIcon size={16} />
      </button>)}
    </div>
    <p className="prospection-section__hint">L’emploi et l’adresse e-mail ont des validations distinctes. Un e-mail non vérifié ne remet pas en cause la validation de l’emploi.</p>
  </section>
}
