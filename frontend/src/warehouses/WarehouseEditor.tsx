import { useState, type SyntheticEvent } from 'react'
import { ApiError } from '../api/client'
import { useWarehouse, useWarehouseWrites, type Warehouse, type WarehouseInput } from '../api/warehouses'
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
      <legend>Le site</legend>
      {text('name', 'Nom de l’entrepôt', true)}
      <div className="warehouse-form__grid">{text('city', 'Ville')}{text('postal_code', 'Code postal')}</div>
      {text('address', 'Adresse')}{text('siret', 'SIRET')}
    </fieldset>
    <fieldset disabled={save.isPending}>
      <legend>Propriétaire immobilier ou foncier</legend>
      {text('owner_name', 'Nom du propriétaire')}{text('owner_role', 'Fonction ou société du propriétaire')}
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
