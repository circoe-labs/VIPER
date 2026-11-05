import { Link } from 'react-router'
import { useId } from 'react'

import type { CompanyCounts, CompanyKindSelection } from '../api/companies'
import { Button } from '../ui/Button'
import './company-kind-filter.css'

const OPTIONS = [
  { value: null, label: 'Toutes' },
  { value: 'institutional', label: 'Institutionnelles' },
  { value: 'sme', label: 'PME' },
  { value: 'large', label: 'Grosses entreprises' },
  { value: 'unclassified', label: 'À classer' },
] as const

export function CompanyKindFilter({ value, onChange, counts }: {
  value: CompanyKindSelection
  onChange: (value: CompanyKindSelection) => void
  counts?: CompanyCounts
}) {
  const id = useId()
  return (
    <div className="company-kind-filter">
      <div className="company-kind-filter__options" role="group" aria-label="Type d’entreprise">
        <span className="company-kind-filter__label">Entreprises</span>
        {OPTIONS.map((option) => (
          <Button
            key={option.value ?? 'all'}
            size="sm"
            variant={value === option.value ? 'primary' : 'secondary'}
            aria-pressed={value === option.value}
            aria-label={option.label}
            aria-describedby={counts ? `${id}-${option.value ?? 'all'}` : undefined}
            onClick={() => {
              onChange(option.value)
            }}
          >
            {option.label}
            {counts && <span id={`${id}-${option.value ?? 'all'}`} className="company-kind-filter__count">{new Intl.NumberFormat('fr-FR').format(counts[option.value ?? 'all'])}</span>}
          </Button>
        ))}
      </div>
      <p className="company-kind-filter__hint">
        Le type se renseigne dans la <Link to="/prospection/companies">fiche entreprise</Link>.
        {' '}Les entreprises sans type restent dans « À classer ».
      </p>
    </div>
  )
}
