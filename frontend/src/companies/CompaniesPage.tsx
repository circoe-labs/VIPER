import { useState } from 'react'
import { Link } from 'react-router'

import { COMPANY_PAGE_SIZE, useCompanies } from '../api/companies'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
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
import { Table } from '../ui/Table'
import { useCompanyEditor } from './CompanyEditorProvider'
import { formatSiren } from './companyForm'
import './companies.css'

// Entreprises (Task 07), a secondary page of Prospection (`/prospection/companies`): search the companies and open
// the lightweight Company editor. Deliberately compact — the people list is Prospection's job (Task 14).
export function CompaniesPage() {
  const openEditor = useCompanyEditor()
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const query = useDebouncedValue(search.trim(), 250)
  const companies = useCompanies(query, offset)
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
        (query ? (
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
          <Table caption="Liste des entreprises">
            <thead>
              <tr>
                <th scope="col">Entreprise</th>
                <th scope="col">SIREN</th>
                <th scope="col">Domaine e-mail</th>
                <th scope="col">Ville</th>
                <th scope="col">Segment</th>
                <th scope="col" className="table__numeric">
                  Établissements
                </th>
                <th scope="col" className="table__numeric">
                  Prospects
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((company) => (
                <tr key={company.id}>
                  <td>
                    <button
                      type="button"
                      className="companies-table__open"
                      onClick={() => {
                        openEditor(company.id)
                      }}
                    >
                      {company.display_name}
                    </button>
                    {company.legal_name && company.legal_name !== company.display_name && (
                      <span className="companies-table__legal">{company.legal_name}</span>
                    )}
                  </td>
                  <td className="companies-table__id">{company.siren ? formatSiren(company.siren) : '—'}</td>
                  <td>{company.email_domain ?? '—'}</td>
                  <td>{company.city ?? '—'}</td>
                  <td>{company.commercial_segment_label ?? '—'}</td>
                  <td className="table__numeric">{company.establishment_count}</td>
                  <td className="table__numeric">{company.prospect_count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
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
