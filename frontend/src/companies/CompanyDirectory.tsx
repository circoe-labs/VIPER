import { useId, useState } from 'react'
import { Link } from 'react-router'
import { COMPANY_PAGE_SIZE, type CompanyKindSelection, useCompanies, useCompanyCounts } from '../api/companies'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'
import { CompanyKindFilter } from './CompanyKindFilter'
import { CompanyTable } from './CompanyTable'
import './companies.css'
import './company-directory.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

export function CompanyDirectory({ value, onChange }: { value: CompanyKindSelection; onChange: (kind: CompanyKindSelection) => void }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const query = useDebouncedValue(search.trim(), 250)
  const counts = useCompanyCounts()
  const companies = useCompanies(query, offset, COMPANY_PAGE_SIZE, value)
  const page = companies.data
  const last = page ? Math.min(offset + page.items.length, page.total) : 0
  return <section className="company-directory" aria-label="Répertoire des entreprises">
    <CompanyKindFilter counts={counts.data} value={value} onChange={(kind) => { setOffset(0); setOpen(true); onChange(kind) }} />
    <div className="company-directory__heading">
      <button type="button" className="company-directory__toggle" aria-expanded={open} aria-controls={id} aria-label={open ? 'Masquer les entreprises' : 'Afficher les entreprises'} onClick={() => { setOpen(!open) }}>
        <ChevronDownIcon size={18} className={open ? 'company-directory__chevron--open' : ''} />
        <span>Liste des entreprises</span>
        <span className="company-directory__count">{page ? NUMBER.format(page.total) : '—'}</span>
      </button>
      <Link to="/prospection/companies">Ouvrir le répertoire complet</Link>
    </div>
    {counts.isError && <p role="alert" className="company-editor__state company-editor__state--error">Répartition indisponible. <Button size="sm" onClick={() => void counts.refetch()}>Réessayer</Button></p>}
    <div id={id} hidden={!open} className="company-directory__body">
      <div className="companies-page__toolbar">
        <SearchField label="Rechercher une entreprise : nom, SIREN, SIRET, domaine" value={search} onChange={(text) => { setSearch(text); setOffset(0) }} />
        {page && <span className="companies-page__count" aria-live="polite">{NUMBER.format(page.total)} entreprise{page.total > 1 ? 's' : ''}</span>}
      </div>
      <p className="company-directory__hint">Chaque entreprise apparaît une seule fois, y compris celles sans prospect associé.</p>
      {companies.isPending && <p role="status" className="company-editor__state">Chargement des entreprises…</p>}
      {companies.isError && <p role="alert" className="company-editor__state company-editor__state--error">Liste des entreprises indisponible. <Button size="sm" onClick={() => void companies.refetch()}>Réessayer</Button></p>}
      {page && page.total === 0 && <p className="company-editor__state">Aucune entreprise ne correspond à cette sélection.</p>}
      {page && page.items.length > 0 && <CompanyTable items={page.items} />}
      {page && page.total > COMPANY_PAGE_SIZE && <nav className="companies-page__pager" aria-label="Pages des entreprises">
        <span>{NUMBER.format(offset + 1)}–{NUMBER.format(last)} sur {NUMBER.format(page.total)}</span>
        <Button size="sm" icon={ChevronLeftIcon} disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - COMPANY_PAGE_SIZE)) }}>Précédentes</Button>
        <Button size="sm" icon={ChevronRightIcon} disabled={last >= page.total} onClick={() => { setOffset(offset + COMPANY_PAGE_SIZE) }}>Suivantes</Button>
      </nav>}
    </div>
  </section>
}
