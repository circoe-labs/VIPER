import { type SyntheticEvent, useState } from 'react'

import { ApiError } from '../api/client'
import { useWarehouseWrites } from '../api/warehouses'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { TextField } from '../ui/fields'
import { CheckCircleIcon } from '../ui/icons'

// Saisie d'un prospect d'entrepôt, sur une seule page : l'entreprise, la personne, sa fonction, son e-mail, son
// LinkedIn, la catégorie (« PME / TPE » ou « Autre entreprise »), puis « Validé, suivant » enregistre la fiche et
// vide le formulaire pour le prospect suivant. Le contact est marqué « à contacter » : son brouillon apparaît dans
// Entrepôts > Brouillons, avec le texte de sa catégorie. Un prospect d'entrepôt compte comme valide.

type Category = 'sme' | 'other'

const EMPTY = { company: '', firstName: '', lastName: '', role: '', email: '', linkedin: '' }
const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'sme', label: 'PME / TPE' },
  { value: 'other', label: 'Autre entreprise' },
]

export function WarehouseProspectForm() {
  const writes = useWarehouseWrites()
  const [form, setForm] = useState(EMPTY)
  const [category, setCategory] = useState<Category | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const set = (field: keyof typeof EMPTY) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [field]: event.target.value }))
  }

  function save() {
    setNotice(null)
    const company = form.company.trim()
    const firstName = form.firstName.trim()
    const lastName = form.lastName.trim()
    const email = form.email.trim()
    if (!company || !firstName || !lastName) {
      setError('Renseignez l’entreprise, le prénom et le nom.')
      return
    }
    if (!category) {
      setError('Choisissez « PME / TPE » ou « Autre entreprise ».')
      return
    }
    if (email && !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(email)) {
      setError('Renseignez une seule adresse e-mail valide.')
      return
    }
    setError(null)
    const fullName = `${firstName} ${lastName.toUpperCase()}`
    writes.save.mutate(
      {
        id: null,
        data: {
          name: company,
          prospecting_category: category,
          owner_name: null,
          owner_role: null,
          owner_email: null,
          owner_linkedin: null,
          address: null,
          postal_code: null,
          city: null,
          siret: null,
          notes: null,
          contacts: [
            { full_name: fullName, role: form.role.trim() || null, email: email || null, linkedin: form.linkedin.trim() || null, to_contact: true },
          ],
        },
      },
      {
        onSuccess: () => {
          // Next prospect: the category stays as chosen, since entries often come in series.
          setForm(EMPTY)
          setNotice(`${fullName} (${company}) est enregistré·e.`)
        },
        onError: (failure) => {
          setError(failure instanceof ApiError ? failure.message : 'L’enregistrement a échoué. Réessayez.')
        },
      },
    )
  }

  return (
    <Card title="Nouveau prospect d’entrepôt">
      <form
        className="verification-warehouse-form"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
        }}
      >
        <div className="verification-warehouse-form__row">
          <TextField label="Entreprise" value={form.company} onChange={set('company')} required />
          <TextField label="Prénom" value={form.firstName} onChange={set('firstName')} required />
          <TextField label="Nom" value={form.lastName} onChange={set('lastName')} required />
        </div>
        <div className="verification-warehouse-form__row">
          <TextField label="Fonction" value={form.role} onChange={set('role')} />
          <TextField label="E-mail" type="email" value={form.email} onChange={set('email')} />
          <TextField label="LinkedIn" value={form.linkedin} onChange={set('linkedin')} placeholder="https://www.linkedin.com/in/…" />
        </div>
        {error && <p role="alert" className="verification__error">{error}</p>}
        {notice && <p role="status" className="verification__notice">{notice}</p>}
        <div className="verification-warehouse__actions" role="group" aria-label="Catégorie de l’entreprise">
          {CATEGORIES.map((item) => (
            <Button
              key={item.value}
              variant={category === item.value ? 'primary' : 'secondary'}
              aria-pressed={category === item.value}
              onClick={() => { setCategory(item.value) }}
            >
              {item.label}
            </Button>
          ))}
          <span className="verification-warehouse__spacer" />
          <Button variant="primary" icon={CheckCircleIcon} loading={writes.save.isPending} onClick={save}>
            Validé, suivant
          </Button>
        </div>
      </form>
    </Card>
  )
}
