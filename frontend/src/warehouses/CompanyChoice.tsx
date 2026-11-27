import { useId } from 'react'

import { ApiError } from '../api/client'
import type { AttachCompanyInput, CompanyProposal, CompanySource } from '../api/warehouses'
import { CompanyPicker } from '../prospects/pickers'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'

// The owning company of a warehouse that has none: what VIPER proposes (with its source), and the person's choice.
// Nothing is attached until they confirm it.

const SOURCES: Record<CompanySource, string> = {
  domain: 'domaine e-mail',
  owner: 'propriétaire indiqué',
  name: 'nom de l’entrepôt',
  similar_name: 'nom proche',
}

export const sourcesLabel = (sources: readonly CompanySource[]) => sources.map((source) => SOURCES[source]).join(', ')

export function proposalText(proposal: CompanyProposal): string {
  const source = sourcesLabel(proposal.sources)
  switch (proposal.status) {
    case 'existing':
      return `${proposal.company_name ?? ''} · société existante · ${source}`
    case 'new':
      return `${proposal.company_name ?? ''} · à créer · ${source}`
    case 'ambiguous':
      return 'Pas de proposition : plusieurs sociétés ressemblantes'
    case 'several':
      return 'Pas de proposition : plusieurs sociétés dans le nom'
    default:
      return 'Pas de proposition'
  }
}

export function initialChoice(proposal: CompanyProposal | null | undefined): AttachCompanyInput | null {
  if (proposal?.status === 'existing' && proposal.company_id) return { company_id: proposal.company_id }
  if (proposal?.status === 'new' && proposal.company_name) return { new_name: proposal.company_name }
  return null
}

export function validChoice(choice: AttachCompanyInput | null): choice is AttachCompanyInput {
  return choice !== null && Boolean('company_id' in choice ? choice.company_id : choice.new_name.trim())
}

export function attachFailure(error: unknown): string {
  const detail = error instanceof ApiError && typeof error.detail === 'object' ? (error.detail as { code?: string } | null) : null
  switch (detail?.code) {
    case 'company_ambiguous':
      return 'Plusieurs sociétés portent ce nom : choisissez-en une.'
    case 'already_attached':
      return 'Cet entrepôt vient d’être rattaché à une autre société.'
    case 'siret_other_company':
      return 'Le SIRET de l’entrepôt appartient à une autre société : vérifiez la fiche.'
    case 'invalid':
      return 'Vérifiez la société choisie.'
    default:
      return 'Le rattachement n’a pas été enregistré. Réessayez.'
  }
}

export function CompanyChoice({ proposal, value, onChange }: { proposal: CompanyProposal; value: AttachCompanyInput | null; onChange: (choice: AttachCompanyInput | null) => void }) {
  const id = useId()
  const creating = value !== null && 'new_name' in value
  const selected = value !== null && 'company_id' in value ? value.company_id : null
  const known = [
    ...(proposal.status === 'existing' && proposal.company_id ? [{ company_id: proposal.company_id, company_name: proposal.company_name ?? '', sources: proposal.sources }] : []),
    ...proposal.candidates,
  ]
  // A name to start from when creating one: the proposal, else nothing (never guessed from several).
  const suggested = proposal.status === 'new' ? proposal.company_name ?? '' : ''
  return <div className="warehouse-company">
    <div className="warehouse-company__modes" role="radiogroup" aria-label={`Société de ${proposal.warehouse_name}`}>
      <label><input type="radio" name={id} checked={!creating} onChange={() => { onChange(initialChoice(proposal.status === 'existing' ? proposal : null)) }} />Société existante</label>
      <label><input type="radio" name={id} checked={creating} onChange={() => { onChange({ new_name: suggested }) }} />Nouvelle société</label>
    </div>
    {creating
      ? <TextField label="Nom de la nouvelle société" required maxLength={255} value={value.new_name} onChange={(event) => { onChange({ new_name: event.target.value }) }} />
      : <CompanyPicker id={`${id}-company`} value={selected} selectedLabel={known.find((c) => c.company_id === selected)?.company_name ?? null} onChange={(company) => { onChange(company ? { company_id: company } : null) }} />}
    {proposal.candidates.length > 0 && <div className="warehouse-company__candidates" aria-label="Sociétés ressemblantes">
      {proposal.candidates.map((c) => <Button key={c.company_id} size="sm" aria-pressed={selected === c.company_id} variant={selected === c.company_id ? 'primary' : 'secondary'} onClick={() => { onChange({ company_id: c.company_id }) }}>{c.company_name} ({sourcesLabel(c.sources)})</Button>)}
    </div>}
  </div>
}
