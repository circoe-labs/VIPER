import { useState, type SyntheticEvent } from 'react'
import { ApiError } from '../api/client'
import { useCompanies, useCompany } from '../api/companies'
import { useWarehouse, useWarehouseWrites, type Warehouse, type WarehouseInput } from '../api/warehouses'
import { Combobox } from '../ui/Combobox'
import { Button, IconButton } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { TextAreaField, TextField } from '../ui/fields'
import { PlusIcon, TrashIcon } from '../ui/icons'

export function warehouseError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Cette fiche a changé. Fermez-la et rouvrez-la avant de réessayer.'
    if (typeof error.detail === 'object' && error.detail !== null && 'message' in error.detail && typeof error.detail.message === 'string') return error.detail.message
  }
  return 'Impossible d’enregistrer. Vérifiez les champs et réessayez.'
}

const EMPTY: WarehouseInput = { name: '', owner_name: null, owner_role: null, owner_email: null, owner_linkedin: null, address: null, postal_code: null, city: null, siret: null, notes: null, contacts: [] }

export function WarehouseEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useWarehouse(id)
  const [loaded, setLoaded] = useState(id === null)
  if (!loaded && query.isFetchedAfterMount && query.isSuccess) setLoaded(true)
  return <Drawer open title={id ? 'Modifier l’entrepôt' : 'Ajouter un entrepôt'} onClose={onClose} size="lg">
    {!loaded ? query.isError ? <p role="alert">Fiche indisponible. <Button onClick={() => void query.refetch()}>Réessayer</Button></p> : <p role="status">Chargement de la fiche…</p> :
      <WarehouseForm key={id ?? 'new'} warehouse={id ? query.data : undefined} onClose={onClose} />}
  </Drawer>
}

// Company (searchable) then one of its buildings: the warehouse is that building.
function BuildingPicker({ value, initialCompanyId, initialCompanyName, onChange }: { value: string | null; initialCompanyId: string | null; initialCompanyName: string | null; onChange: (establishmentId: string | null) => void }) {
  const [companyId, setCompanyId] = useState<string | null>(initialCompanyId)
  const [search, setSearch] = useState('')
  const companies = useCompanies(search, 0, 20)
  const company = useCompany(companyId)
  const options = [
    ...(companies.data?.items ?? []).map((item) => ({ id: item.id, label: item.display_name })),
    ...(initialCompanyId && initialCompanyName && !(companies.data?.items ?? []).some((item) => item.id === initialCompanyId) ? [{ id: initialCompanyId, label: initialCompanyName }] : []),
  ]
  const buildings = company.data?.establishments ?? []
  return <>
    <Combobox label="Société" options={options} value={companyId} placeholder="Rechercher une société" onQueryChange={setSearch} onChange={(next) => { setCompanyId(next); onChange(null) }} />
    <label className="field"><span className="field__label">Bâtiment</span>
      <select className="field__control" value={value ?? ''} disabled={!companyId} onChange={(event) => { onChange(event.target.value || null) }}>
        <option value="">{companyId ? 'Choisir un bâtiment' : 'Choisissez d’abord une société'}</option>
        {buildings.map((building) => <option key={building.id} value={building.id}>{[building.name, building.postal_code, building.city].filter(Boolean).join(' · ') || 'Bâtiment sans nom'}</option>)}
      </select>
    </label>
  </>
}

function WarehouseForm({ warehouse, onClose }: { warehouse: Warehouse | undefined; onClose: () => void }) {
  const [draft, setDraft] = useState<WarehouseInput>(() => warehouse ? { ...warehouse, contacts: warehouse.contacts.map((contact) => ({ ...contact })) } : { ...EMPTY, contacts: [] })
  const [baseline] = useState(warehouse)
  const { save } = useWarehouseWrites()
  const [error, setError] = useState<string | null>(null)
  const change = (field: keyof Omit<WarehouseInput, 'contacts'>, value: string) => { setDraft((current) => ({ ...current, [field]: field === 'name' ? value : value || null })) }
  const text = (field: keyof Omit<WarehouseInput, 'contacts'>, label: string, required = false) => <TextField label={label} value={draft[field] ?? ''} required={required} maxLength={field === 'siret' ? 32 : field === 'postal_code' ? 16 : field === 'name' || field === 'owner_name' ? 500 : field === 'city' ? 255 : 2000} onChange={(event) => { change(field, event.target.value) }} />
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      await save.mutateAsync({ id: baseline?.id ?? null, version: baseline?.version, data: draft })
      onClose()
    } catch (caught) { setError(warehouseError(caught)) }
  }
  return <form className="warehouse-form" onSubmit={(event) => { void submit(event) }}>
    <fieldset disabled={save.isPending}>
      <legend>Société et bâtiment</legend>
      <p className="warehouse-muted">Un entrepôt est un bâtiment (établissement) d’une société. Il n’est exploitable que rattaché à une société exploitable.</p>
      <BuildingPicker value={draft.establishment_id ?? null} initialCompanyId={warehouse?.company_id ?? null} initialCompanyName={warehouse?.company_name ?? null} onChange={(establishmentId) => { setDraft((current) => ({ ...current, establishment_id: establishmentId })) }} />
    </fieldset>
    <fieldset disabled={save.isPending}>
      <legend>Le site</legend>
      {text('name', 'Nom de l’entrepôt', true)}
      <label className="field"><span className="field__label">Catégorie de prospection</span><select className="field__control" value={draft.prospecting_category ?? ''} onChange={(event) => setDraft((current) => ({ ...current, prospecting_category: event.target.value === 'sme' ? 'sme' : event.target.value === 'other' ? 'other' : null }))}><option value="">À classer</option><option value="sme">PME/TPE</option><option value="other">Autres</option></select></label>
      <div className="warehouse-form__grid">{text('city', 'Ville')}{text('postal_code', 'Code postal')}</div>
      {text('address', 'Adresse')}{text('siret', 'SIRET')}
    </fieldset>
    <fieldset disabled={save.isPending}>
      <legend>Propriétaire immobilier ou foncier</legend>
      {text('owner_name', 'Propriétaire (nom)')}{text('owner_role', 'Fonction du propriétaire')}
      {text('owner_email', 'E-mail du propriétaire')}{text('owner_linkedin', 'LinkedIn du propriétaire')}
    </fieldset>
    <fieldset disabled={save.isPending}>
      <legend>Interlocuteurs à contacter</legend>
      <p className="warehouse-muted">Les adresses alternatives peuvent être conservées telles quelles, puis vérifiées avant contact.</p>
      {draft.contacts.map((contact, index) => <fieldset className="warehouse-contact-form" key={index}>
        <legend>Interlocuteur {index + 1}</legend>
        {(['full_name', 'role', 'email', 'linkedin'] as const).map((field) => <TextField key={field} label={{ full_name: 'Nom et prénom', role: 'Fonction', email: 'E-mail(s) à confirmer', linkedin: 'Profil LinkedIn' }[field]} value={contact[field] ?? ''} maxLength={field === 'full_name' ? 500 : field === 'role' ? 1000 : 2000} required={field === 'full_name'} onChange={(event) => {
          setDraft((current) => ({ ...current, contacts: current.contacts.map((row, position) => position === index ? { ...row, [field]: field === 'full_name' ? event.target.value : event.target.value || null } : row) }))
        }} />)}
        <IconButton icon={TrashIcon} label={`Retirer l’interlocuteur ${String(index + 1)}`} onClick={() => { setDraft((current) => ({ ...current, contacts: current.contacts.filter((_, position) => position !== index) })) }} />
      </fieldset>)}
      <Button icon={PlusIcon} onClick={() => { setDraft((current) => ({ ...current, contacts: [...current.contacts, { full_name: '', role: null, email: null, linkedin: null }] })) }}>Ajouter un interlocuteur</Button>
    </fieldset>
    <TextAreaField label="Notes" value={draft.notes ?? ''} maxLength={10000} onChange={(event) => { change('notes', event.target.value) }} />
    {error && <p role="alert" className="warehouse-error">{error}</p>}
    <div className="warehouse-form__actions"><Button onClick={onClose} disabled={save.isPending}>Annuler</Button><Button type="submit" variant="primary" loading={save.isPending}>Enregistrer</Button></div>
  </form>
}
