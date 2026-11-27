import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { type AttachCompanyInput, type CompanyProposal, type LinkPersonInput, type PersonCandidate, useAttachWarehouseCompany, useLinkWarehousePerson, type WarehousePeople, type WarehousePerson } from '../api/warehouses'
import { formatShortDateTime } from '../contact/labels'
import { BLOCK_LABELS } from '../lifecycle/model'
import { StateBadge } from '../prospection/ContactBadges'
import { prospectionHref } from '../prospection/criteria'
import { CompanyPicker } from '../prospects/pickers'
import { contactHref } from '../prospects/missionMenu/ProspectContactAction'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { SelectField, TextField } from '../ui/fields'
import { BanIcon, MailIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { attachFailure, CompanyChoice, initialChoice, proposalText, validChoice } from './CompanyChoice'

// One person of a warehouse listing in Contact terms: their prospect and where they stand, or the step that makes
// them one (`doc/features/warehouses.md`). Writing, validating, programming and history are Contact's.

const REASONS: Record<PersonCandidate['reasons'][number], string> = {
  same_email: 'même adresse',
  same_name: 'même nom',
  same_company: 'même entreprise',
  same_initial: 'même nom de famille et initiale',
}

const LABELS: Partial<Record<string, string>> = BLOCK_LABELS
const blockLabel = (block: string) => LABELS[block] ?? block
const samePerson = (c: PersonCandidate) => c.reasons.includes('same_name') && (c.reasons.includes('same_email') || c.reasons.includes('same_company'))
const fullName = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`.trim()

function unlinkedBadge(person: WarehousePerson): { label: string; tone: StatusTone } {
  switch (person.status) {
    case 'match':
      return { label: `Fiche trouvée : ${person.candidates[0] ? fullName(person.candidates[0]) : ''}`, tone: 'info' }
    case 'ambiguous':
      return { label: 'À rattacher : homonyme ou fiche proche', tone: 'warning' }
    case 'incomplete':
      return { label: 'Nom incomplet', tone: 'warning' }
    case 'not_a_person':
      return { label: 'Sans nom de personne', tone: 'neutral' }
    default:
      return { label: 'Pas encore prospect', tone: 'neutral' }
  }
}

function LinkedState({ person }: { person: WarehousePerson }) {
  const state = person.state
  if (!state) return null
  const sent = state.sent_count
  return <>
    {state.block && <StatusBadge tone="danger" icon={BanIcon}>{blockLabel(state.block)}</StatusBadge>}
    {state.tracking && state.tracking !== 'neutral' && <StateBadge status={state.tracking} />}
    {state.warehouse_pending && <StatusBadge tone="warning">Mail entrepôt en attente</StatusBadge>}
    {state.next_scheduled_at && <StatusBadge tone="info">Programmé le {formatShortDateTime(state.next_scheduled_at)}</StatusBadge>}
    {sent > 0 && <StatusBadge tone="success">{sent} e-mail{sent > 1 ? 's' : ''} envoyé{sent > 1 ? 's' : ''}</StatusBadge>}
    {sent > 0 && state.last_sent_at && <span className="warehouse-muted">Dernier le {formatShortDateTime(state.last_sent_at)}</span>}
    {state.warehouse_uncounted > 0 && <StatusBadge tone="success">Contacté par mail entrepôt</StatusBadge>}
    {sent === 0 && state.warehouse_uncounted === 0 && !state.next_scheduled_at && !state.warehouse_pending && <StatusBadge tone="neutral">Pas encore contacté</StatusBadge>}
    {state.cohort_code ? <span className="warehouse-muted">Semaine de contact {state.cohort_code}</span> : !state.block && <span className="warehouse-muted">Semaine de contact à choisir</span>}
  </>
}

export function WarehousePersonContact({ warehouseId, person, company }: { warehouseId: string; person: WarehousePerson; company: WarehouseCompany }) {
  const [dialog, setDialog] = useState(false)
  const [countError, setCountError] = useState<string | null>(null)
  const navigate = useNavigate()
  const count = useLinkWarehousePerson(warehouseId)
  async function countAndContact(prospectId: string) {
    setCountError(null)
    try {
      await count.mutateAsync({ contact_name: person.contact_name, prospect_id: prospectId })
      void navigate(contactHref(prospectId))
    } catch (caught) {
      console.error('warehouse_person.count_failed', caught)
      setCountError(failure(caught))
    }
  }
  const label = `Contacter ${person.contact_name}`
  if (person.prospect) {
    const prospectId = person.prospect.id
    const blocked = person.state?.block
    return <div className="warehouse-person">
      <LinkedState person={person} />
      <span className="warehouse-person__actions">
        {blocked
          ? <Button size="sm" icon={MailIcon} disabled title={blockLabel(blocked)} aria-label={label}>Contacter</Button>
          : person.state?.warehouse_uncounted
            ? <Button size="sm" variant="primary" icon={MailIcon} loading={count.isPending} aria-label={label} onClick={() => void countAndContact(prospectId)}>Contacter</Button>
            : <Link className="btn btn--primary btn--sm" to={contactHref(prospectId)} aria-label={label}><MailIcon size={16} />Contacter</Link>}
        <Link className="btn btn--ghost btn--sm" to={prospectionHref({ prospect: person.prospect.id })} aria-label={`Fiche de ${person.contact_name}`}>Fiche</Link>
      </span>
      {countError && <p className="warehouse-error" role="alert">{countError}</p>}
    </div>
  }
  const badge = unlinkedBadge(person)
  const opposed = person.candidates.find((c) => c.block === 'prospect_do_not_contact')
  return <div className="warehouse-person">
    <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
    {opposed && <StatusBadge tone="danger" icon={BanIcon}>Ne pas contacter ({fullName(opposed)})</StatusBadge>}
    {person.status === 'not_a_person'
      ? <InfoTip label={`Pourquoi ${person.contact_name} n’est pas contactable`}>Un message s’adresse à une personne. Renseignez son prénom et son nom avec « Modifier » pour la contacter.</InfoTip>
      : <span className="warehouse-person__actions"><Button size="sm" variant="primary" icon={MailIcon} aria-label={label} onClick={() => { setDialog(true) }}>Contacter</Button></span>}
    {dialog && <LinkPersonDialog warehouseId={warehouseId} person={person} company={company} onClose={() => { setDialog(false) }} />}
  </div>
}

const NEW = 'new'

type WarehouseCompany = Pick<WarehousePeople, 'company_id' | 'company_name' | 'proposal'>

// A warehouse without a company: confirming one here attaches it, so its other people do not ask again.
function AttachCompany({ warehouseId, proposal }: { warehouseId: string; proposal: CompanyProposal }) {
  const attach = useAttachWarehouseCompany()
  const [choice, setChoice] = useState<AttachCompanyInput | null>(() => initialChoice(proposal))
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  async function confirm() {
    if (!validChoice(choice) || sending.current) return
    sending.current = true
    setError(null)
    try {
      await attach.mutateAsync({ warehouseId, choice })
    } catch (caught) {
      console.error('warehouse_company.attach_failed', warehouseId, caught)
      setError(attachFailure(caught))
    } finally {
      sending.current = false
    }
  }
  return <section className="warehouse-link__company" aria-label="Société de l’entrepôt">
    <h3>Société de l’entrepôt</h3>
    <p className="warehouse-muted">{proposalText(proposal)}</p>
    <CompanyChoice proposal={proposal} value={choice} onChange={setChoice} />
    {error && <p className="warehouse-error" role="alert">{error}</p>}
    <div><Button variant="primary" disabled={!validChoice(choice)} loading={attach.isPending} onClick={() => void confirm()}>Rattacher l’entrepôt à cette société</Button></div>
  </section>
}

function failure(error: unknown): string {
  const detail = error instanceof ApiError && typeof error.detail === 'object' ? (error.detail as { code?: string } | null) : null
  switch (detail?.code) {
    case 'person_exists':
      return 'Cette personne est déjà dans la base : rattachez sa fiche (fermez puis rouvrez pour la voir).'
    case 'person_to_confirm':
      return 'Une fiche ressemblante existe : choisissez-la, ou « Créer une nouvelle fiche » pour confirmer qu’il s’agit d’une autre personne.'
    case 'already_linked':
      return 'Cette personne vient d’être rattachée. Fermez : la liste est actualisée.'
    case 'not_found':
      return 'Cette personne n’est plus dans la liste de l’entrepôt. Fermez et rechargez.'
    case 'invalid':
      return 'Vérifiez le prénom, le nom (100 caractères au plus) et l’entreprise.'
    default:
      return 'Le rattachement n’a pas été enregistré. Réessayez.'
  }
}

function LinkPersonDialog({ warehouseId, person, company, onClose }: { warehouseId: string; person: WarehousePerson; company: WarehouseCompany; onClose: () => void }) {
  const navigate = useNavigate()
  const link = useLinkWarehousePerson(warehouseId)
  // The same person, or an opposed address: only their existing record can be chosen.
  const mustLink = person.candidates.some((c) => samePerson(c) || (c.reasons.includes('same_email') && c.block === 'prospect_do_not_contact'))
  const [choice, setChoice] = useState<string>(() => person.status === 'match' ? person.candidates[0]?.prospect_id ?? '' : person.candidates.length ? '' : NEW)
  const [first, setFirst] = useState(person.first_name)
  const [last, setLast] = useState(person.last_name)
  const [civility, setCivility] = useState(person.civility ?? '')
  // The person's company: the warehouse's (once attached) unless another one is chosen.
  const [chosenCompany, setCompanyId] = useState<string | null>(null)
  const companyId = chosenCompany ?? company.company_id
  const [error, setError] = useState<string | null>(null)
  // Attaching the company may reveal the same person: a new record is then no longer offered.
  const creating = choice === NEW && !mustLink
  const ready = creating ? Boolean(first.trim() && last.trim() && companyId) : choice !== '' && choice !== NEW

  // A double click arrives before the button is disabled: one request only. Kept after a success (the page leaves).
  const sending = useRef(false)
  async function submit() {
    if (sending.current) return
    sending.current = true
    setError(null)
    const body: LinkPersonInput = { contact_name: person.contact_name }
    if (creating) {
      body.create = { first_name: first.trim(), last_name: last.trim(), civility: civility === 'mr' || civility === 'ms' ? civility : null, company_id: companyId ?? '' }
      // Choosing « new » while look-alikes are shown is the person saying it is someone else.
      body.distinct_confirmed = person.candidates.length > 0
    } else {
      body.prospect_id = choice
    }
    try {
      const { prospect_id } = await link.mutateAsync(body)
      void navigate(contactHref(prospect_id))
    } catch (caught) {
      sending.current = false
      console.error('warehouse_person.link_failed', caught)
      setError(failure(caught))
    }
  }

  return <Modal open title={`Contacter ${person.contact_name}`} onClose={onClose} size="md" footer={<>
    <Button onClick={onClose}>Annuler</Button>
    <Button variant="primary" disabled={!ready} loading={link.isPending} onClick={() => void submit()}>{creating ? 'Créer la fiche et contacter' : 'Rattacher et contacter'}</Button>
  </>}>
    <div className="warehouse-link">
      <p className="warehouse-muted">{[person.role, ...person.emails].filter(Boolean).join(' · ') || 'Aucune adresse dans la liste'}</p>
      {!company.company_id && company.proposal && <AttachCompany warehouseId={warehouseId} proposal={company.proposal} />}
      {person.candidates.length > 0 && <fieldset className="warehouse-link__choices">
        <legend>Fiches existantes</legend>
        {person.candidates.map((c) => <label key={c.prospect_id}>
          <input type="radio" name="person" checked={choice === c.prospect_id} onChange={() => { setChoice(c.prospect_id) }} />
          <span><strong>{fullName(c)}</strong> {c.company_name ?? 'Sans entreprise'}<span className="warehouse-muted"> · {c.reasons.map((r) => REASONS[r]).join(', ')}</span></span>
          {c.block && <StatusBadge tone="danger" icon={BanIcon}>{blockLabel(c.block)}</StatusBadge>}
        </label>)}
        {!mustLink && <label><input type="radio" name="person" checked={creating} onChange={() => { setChoice(NEW) }} /><span>Créer une nouvelle fiche (une autre personne)</span></label>}
      </fieldset>}
      {creating && (company.company_id || !company.proposal) && <div className="warehouse-form__grid">
        <TextField label="Prénom" required value={first} onChange={(e) => { setFirst(e.target.value) }} />
        <TextField label="Nom" required value={last} onChange={(e) => { setLast(e.target.value) }} />
        <SelectField label="Civilité" value={civility} onChange={(e) => { setCivility(e.target.value) }}>
          <option value="">Non renseignée</option>
          <option value="mr">M.</option>
          <option value="ms">Mme</option>
        </SelectField>
        <CompanyPicker id="warehouse-person-company" value={companyId} selectedLabel={companyId === company.company_id ? company.company_name : null} onChange={setCompanyId} />
      </div>}
      {error && <p className="warehouse-error" role="alert">{error}</p>}
    </div>
  </Modal>
}
