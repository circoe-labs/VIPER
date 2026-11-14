import type { ReactNode } from 'react'

import type { ContactOverview } from '../api/contact'
import { ActiveChips, type ChipData, ControlBar, FilterMenu } from '../ui/ControlBar'
import { SelectField } from '../ui/fields'
import { type ContactView, VALIDATION_BOXES, type ValidationBox } from './criteria'

// « Statut du prospect » (validation of the person's employment), same words as Prospection's quick filters.
const VALIDATION_LABELS: Record<ValidationBox, string> = { validated: 'Emploi validé', uncertain: 'Incertains', todo: 'À vérifier', ignored: 'Mis de côté' }
const VALIDATION_HINTS: Record<ValidationBox, string> = {
  validated: 'Validation de l’emploi enregistrée',
  uncertain: 'Fonction à vérifier',
  todo: 'Validation de l’emploi non enregistrée',
  ignored: 'Prospects mis de côté, conservés dans la base',
}

interface ContactControlsProps {
  view: ContactView
  search: ReactNode
  // Statuses and companies the server offers (GET /contact/overview); empty while it loads.
  options: Pick<ContactOverview, 'statuses' | 'companies'> | undefined
  // The « Semaine d’envoi » choice of the « À contacter » list, when it has one.
  week: ReactNode
  weekLabel: string | null
  onChange: (patch: Partial<ContactView>) => void
  onClear: () => void
}

// Contact's control bar: search, « Filtres » (contact status, prospect validation, company, send week) and the applied
// filters as chips. Every criterion lives in the URL (criteria.ts).
export function ContactControls({ view, search, options, week, weekLabel, onChange, onClear }: ContactControlsProps) {
  const statusLabel = options?.statuses.find((status) => status.value === view.status)?.label ?? view.status
  const companyLabel = view.company === 'none' ? 'Sans entreprise' : (options?.companies.find((company) => company.id === view.company)?.label ?? 'sélectionnée')
  const chips: ChipData[] = []
  if (view.status) chips.push({ id: 'status', label: `Statut : ${statusLabel ?? ''}`, onRemove: () => { onChange({ status: null }) } })
  if (view.validation) chips.push({ id: 'validation', label: VALIDATION_LABELS[view.validation], onRemove: () => { onChange({ validation: null }) } })
  if (view.company) chips.push({ id: 'company', label: `Entreprise : ${companyLabel}`, onRemove: () => { onChange({ company: null }) } })
  if (view.week) chips.push({ id: 'week', label: `Semaine d’envoi : ${weekLabel ?? view.week}`, onRemove: () => { onChange({ week: null }) } })

  return (
    <div role="search" aria-label="Rechercher dans la liste">
      <ControlBar
        search={search}
        filters={
          <FilterMenu count={chips.length}>
            {() => (
              <>
                <div className="filters-menu__group" role="group" aria-label="Statut du prospect">
                  <span className="filters-menu__title" aria-hidden="true">Statut du prospect</span>
                  <div className="filters-menu__quick">
                    {VALIDATION_BOXES.map((box) => (
                      <button key={box} type="button" className="filters-menu__option" aria-pressed={view.validation === box} title={VALIDATION_HINTS[box]} onClick={() => { onChange({ validation: view.validation === box ? null : box }) }}>
                        {VALIDATION_LABELS[box]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="filters-menu__fields" role="group" aria-label="Statut de contact">
                  <SelectField label="Statut de contact" value={view.status ?? ''} onChange={(event) => { onChange({ status: event.target.value || null }) }}>
                    <option value="">Tous les statuts</option>
                    {options?.statuses.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                  </SelectField>
                  <SelectField label="Entreprise" value={view.company ?? ''} onChange={(event) => { onChange({ company: event.target.value || null }) }}>
                    <option value="">Toutes les entreprises</option>
                    <option value="none">Sans entreprise</option>
                    {options?.companies.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                  </SelectField>
                  {week}
                </div>
              </>
            )}
          </FilterMenu>
        }
        active={<ActiveChips chips={chips} onClear={onClear} />}
      />
    </div>
  )
}
