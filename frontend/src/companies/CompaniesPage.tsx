import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { COMPANY_PAGE_SIZE, type CompanyKindSelection, useCompanies } from '../api/companies'
import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { CreationPeriod } from '../ui/CreationPeriod'
import { calendarDate } from '../lib/calendarDate'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
  ArrowLeftIcon,
  BuildingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  UploadIcon,
} from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { useCompanyEditor } from './CompanyEditorProvider'
import { CompanyTable } from './CompanyTable'
import { CompanyKindFilter } from './CompanyKindFilter'
import './companies.css'

// Entreprises (Task 07), a secondary page of Prospection (`/prospection/companies`): search the companies and open
// the lightweight Company editor. Deliberately compact — the people list is Prospection's job (Task 14).
export function CompaniesPage() {
  const [params, setParams] = useSearchParams()
  const createdFrom = calendarDate(params.get('created_from'))
  const createdTo = calendarDate(params.get('created_to'))
  const openEditor = useCompanyEditor()
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [kind, setKind] = useState<CompanyKindSelection>(null)
  const query = useDebouncedValue(search.trim(), 250)
  const companies = useCompanies(query, offset, COMPANY_PAGE_SIZE, kind, createdFrom, createdTo)
  const page = companies.data
  const last = page ? Math.min(offset + COMPANY_PAGE_SIZE, page.total) : 0

  return (
    <>
      <Link to="/prospection" className="companies-page__back">
        <ArrowLeftIcon size={16} />
        Prospection
      </Link>
      <PageHeader
        title="Entreprises"
        description="Contexte des prospects : identité, SIREN, classification et établissements. Une fiche légère, pas un dossier commercial."
        actions={
          <>
            <Link to="/prospection/import" className="btn btn--secondary btn--md">
              <UploadIcon size={18} />
              Importer Excel
            </Link>
            <ExportWorkbookButton />
            <Button
              variant="primary"
              icon={PlusIcon}
              onClick={() => {
                openEditor('new')
              }}
            >
              Nouvelle entreprise
            </Button>
          </>
        }
      />
      <CreationPeriod start={createdFrom} end={createdTo} onClear={() => {
        setParams((current) => { current.delete('created_from'); current.delete('created_to'); return current }, { replace: true })
        setOffset(0)
      }} />
      <CompanyKindFilter
        value={kind}
        onChange={(next) => {
          setKind(next)
          setOffset(0)
        }}
      />
      <div className="companies-page__toolbar">
        <SearchField
          label="Rechercher : nom, raison sociale, SIREN, SIRET, domaine"
          value={search}
          onChange={(value) => {
            setSearch(value)
            setOffset(0)
          }}
        />
        {page && (
          <p className="companies-page__count" aria-live="polite">
            {page.total} {page.total > 1 ? 'entreprises' : 'entreprise'}
          </p>
        )}
      </div>

      {companies.isPending && <p className="company-editor__state">Chargement…</p>}
      {companies.isError && (
        <div className="company-editor__state company-editor__state--error" role="alert">
          <AlertIcon size={18} />
          Liste indisponible.
          <Button size="sm" onClick={() => void companies.refetch()}>
            Réessayer
          </Button>
        </div>
      )}
      {page?.total === 0 &&
        (kind ? (
          <p className="company-editor__state">Aucune entreprise dans cette catégorie{query ? ` pour « ${query} »` : ''}.</p>
        ) : query ? (
          <p className="company-editor__state">Aucune entreprise ne correspond à « {query} ».</p>
        ) : (
          <EmptyState
            icon={BuildingIcon}
            title="Aucune entreprise pour l’instant"
            description="Créez la première fiche : nom, identifiants, classification et établissements."
            action={
              <Button
                icon={PlusIcon}
                onClick={() => {
                  openEditor('new')
                }}
              >
                Nouvelle entreprise
              </Button>
            }
          />
        ))}
      {page && page.items.length > 0 && (
        <>
          <CompanyTable items={page.items} />
          {page.total > COMPANY_PAGE_SIZE && (
            <nav className="companies-page__pager" aria-label="Pages de la liste">
              <span>
                {offset + 1}–{last} sur {page.total}
              </span>
              <Button
                size="sm"
                icon={ChevronLeftIcon}
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - COMPANY_PAGE_SIZE))
                }}
              >
                Précédentes
              </Button>
              <Button
                size="sm"
                icon={ChevronRightIcon}
                disabled={last >= page.total}
                onClick={() => {
                  setOffset(offset + COMPANY_PAGE_SIZE)
                }}
              >
                Suivantes
              </Button>
            </nav>
          )}
        </>
      )}
    </>
  )
}
