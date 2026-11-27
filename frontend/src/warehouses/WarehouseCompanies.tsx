import { useRef, useState } from 'react'

import { type AttachCompanyInput, type CompanyProposal, useAttachWarehouseCompany, useCompanyProposals } from '../api/warehouses'
import { Button } from '../ui/Button'
import { PencilIcon, SpinnerIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { attachFailure, CompanyChoice, initialChoice, proposalText, validChoice } from './CompanyChoice'
import './warehouses.css'

// `/prospection/warehouse-companies`: every warehouse without a company that lists someone, one line each. A person
// accepts or edits each proposal, then attaches the checked lines.

function Line({ proposal, checked, choice, error, disabled, onCheck, onChoice }: {
  proposal: CompanyProposal; checked: boolean; choice: AttachCompanyInput | null; error: string | undefined; disabled: boolean
  onCheck: (checked: boolean) => void; onChoice: (choice: AttachCompanyInput | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const edited = JSON.stringify(choice) !== JSON.stringify(initialChoice(proposal))
  return <li className="warehouse-companies__line">
    <label className="warehouse-companies__site">
      <input type="checkbox" checked={checked} disabled={disabled || !validChoice(choice)} onChange={(event) => { onCheck(event.target.checked) }} aria-label={`Rattacher ${proposal.warehouse_name}`} />
      <span><strong>{proposal.warehouse_name}</strong><span className="warehouse-muted">{[proposal.city, `${String(proposal.people)} personne${proposal.people > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</span></span>
    </label>
    <span className={validChoice(choice) ? undefined : 'warehouse-muted'}>{edited ? 'Choix modifié' : proposalText(proposal)}</span>
    <Button size="sm" icon={PencilIcon} aria-expanded={editing} disabled={disabled} onClick={() => { setEditing(!editing) }} aria-label={`${choice ? 'Modifier' : 'Choisir'} la société de ${proposal.warehouse_name}`}>{choice ? 'Modifier' : 'Choisir'}</Button>
    {editing && <div className="warehouse-companies__editor"><CompanyChoice proposal={proposal} value={choice} onChange={onChoice} /></div>}
    {error && <p className="warehouse-error warehouse-companies__editor" role="alert">{error}</p>}
  </li>
}

export function WarehouseCompaniesPage() {
  const query = useCompanyProposals()
  const attach = useAttachWarehouseCompany()
  const [choices, setChoices] = useState<Record<string, AttachCompanyInput | null>>({})
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [summary, setSummary] = useState('')
  const stop = useRef(false)
  const stopRequested = () => stop.current
  const items = query.data ?? []
  const choiceOf = (item: CompanyProposal) => (item.warehouse_id in choices ? choices[item.warehouse_id] ?? null : initialChoice(item))
  const selected = items.filter((item) => checked.has(item.warehouse_id) && validChoice(choiceOf(item)))
  const proposed = items.filter((item) => validChoice(choiceOf(item)))
  const check = (id: string, value: boolean) => {
    setChecked((current) => {
      const next = new Set(current)
      if (value) next.add(id); else next.delete(id)
      return next
    })
  }

  async function run() {
    stop.current = false
    setSummary('')
    setErrors({})
    let attached = 0
    let failed = 0
    for (const [index, item] of selected.entries()) {
      if (stopRequested()) break
      setProgress({ done: index, total: selected.length })
      const choice = choiceOf(item)
      if (!validChoice(choice)) continue
      try {
        await attach.mutateAsync({ warehouseId: item.warehouse_id, choice })
        attached += 1
        check(item.warehouse_id, false)
      } catch (caught) {
        failed += 1
        console.error('warehouse_company.attach_failed', item.warehouse_id, caught)
        setErrors((current) => ({ ...current, [item.warehouse_id]: attachFailure(caught) }))
      }
    }
    setProgress(null)
    setSummary(`${String(attached)} entrepôt${attached > 1 ? 's' : ''} rattaché${attached > 1 ? 's' : ''}${failed ? `, ${String(failed)} en échec` : ''}.`)
  }

  return <div className="warehouses-page">
    <PageHeader mascot="build" back={{ to: '/prospection?entity=warehouse', label: 'Entrepôts' }} title="Sociétés des entrepôts" description="Confirmez la société de chaque entrepôt qui n’en a pas." />
    {query.isPending && <p role="status" className="warehouse-muted"><SpinnerIcon size={16} className="btn__spinner" /> Recherche des propositions…</p>}
    {query.isError && <p role="alert" className="warehouse-error">Impossible de charger les propositions. <Button size="sm" onClick={() => void query.refetch()}>Réessayer</Button></p>}
    {query.data && items.length === 0 && <p className="warehouse-muted">Tous les entrepôts qui listent quelqu’un ont une société.</p>}
    {items.length > 0 && <>
      <div className="warehouse-toolbar">
        <strong>{items.length} entrepôt{items.length > 1 ? 's' : ''} sans société</strong>
        <Button disabled={progress !== null || proposed.length === 0} onClick={() => { setChecked(new Set(proposed.map((item) => item.warehouse_id))) }}>Cocher les {proposed.length} lignes renseignées</Button>
        <Button variant="primary" disabled={selected.length === 0 || progress !== null} loading={progress !== null} onClick={() => void run()}>Rattacher la sélection ({selected.length})</Button>
        {progress && <><span role="status" className="warehouse-muted">Rattachement {progress.done + 1} / {progress.total}…</span><Button size="sm" onClick={() => { stop.current = true }}>Arrêter</Button></>}
      </div>
    </>}
    {summary && <p role="status" className="warehouse-notice">{summary}</p>}
    {items.length > 0 && <ul className="warehouse-companies" aria-label="Entrepôts sans société">
      {items.map((item) => <Line key={item.warehouse_id} proposal={item} checked={checked.has(item.warehouse_id)} choice={choiceOf(item)} error={errors[item.warehouse_id]} disabled={progress !== null}
        onCheck={(value) => { check(item.warehouse_id, value) }}
        onChoice={(choice) => { setChoices((current) => ({ ...current, [item.warehouse_id]: choice })); if (!validChoice(choice)) check(item.warehouse_id, false) }} />)}
    </ul>}
  </div>
}
