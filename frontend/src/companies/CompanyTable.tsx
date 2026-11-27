import { useState } from 'react'

import { COMPANY_KIND_LABELS, type CompanyListItem, useCompanyMutations } from '../api/companies'
import { ConfirmDelete } from '../admin/adminShared'
import { FILE_STATUS_LABELS, FILE_STATUS_TONES, missingText } from '../api/fileStatus'
import { LifecycleBadge } from '../lifecycle/LifecycleBadge'
import { useLifecycleMenu } from '../lifecycle/useLifecycleMenu'
import { StatusBadge } from '../ui/Badge'
import { PencilIcon, TrashIcon } from '../ui/icons'
import { useRowMenu } from '../ui/RowMenu'
import { Table } from '../ui/Table'
import { useCompanyEditor } from './CompanyEditorProvider'
import { formatSiren } from './companyForm'
import './companies.css'

// « Transports Exemple SAS » → « TE »: the first letters of the first two words that start with a letter or a digit.
export function companyInitials(name: string): string {
  const words = name.split(/[\s\-–—'’.,/()]+/).filter((word) => /^[\p{L}\p{N}]/u.test(word))
  const letters = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?']
  return letters.map((word) => (word ?? '').slice(0, words.length > 1 ? 1 : 2)).join('').toLocaleUpperCase('fr')
}

// The companies listing: one row per company with its avatar. The table never scrolls sideways: the secondary columns
// (domain, segment, then SIREN and city) fold away as the page narrows (companies.css), the page itself scrolls.
export function CompanyTable({ items }: { items: CompanyListItem[] }) {
  const openEditor = useCompanyEditor()
  const { remove } = useCompanyMutations()
  const [deleting, setDeleting] = useState<CompanyListItem | null>(null)
  const lifecycle = useLifecycleMenu()
  const rowMenu = useRowMenu<CompanyListItem>(
    (company) => `Actions de ${company.display_name}`,
    (company) => [
      { id: 'edit', label: 'Modifier', icon: PencilIcon, onSelect: () => { openEditor(company.id) } },
      ...lifecycle.items({ type: 'company', id: company.id, name: company.display_name }),
      { id: 'delete', label: 'Supprimer', icon: TrashIcon, danger: true, onSelect: () => { setDeleting(company) } },
    ],
  )
  return <div className="companies-list">
    <Table caption="Liste des entreprises">
      <thead><tr>
        <th scope="col">Entreprise</th><th scope="col">Statut</th><th scope="col">Type</th>
        <th scope="col" className="companies-col--siren">SIREN</th>
        <th scope="col" className="companies-col--domain">Domaine e-mail</th>
        <th scope="col" className="companies-col--city">Ville</th>
        <th scope="col" className="companies-col--segment">Segment</th>
        <th scope="col" className="table__numeric">Établissements</th>
        <th scope="col" className="table__numeric">Prospects</th>
        <th scope="col" className="row-actions"><span className="visually-hidden">Actions</span></th>
      </tr></thead>
      <tbody>{items.map((company) => <tr key={company.id} onContextMenu={rowMenu.onContextMenu(company)}>
        <td>
          <span className="company-cell">
            <span className="company-avatar" aria-hidden="true">{companyInitials(company.display_name)}</span>
            <span className="company-cell__text">
              <button type="button" className="companies-table__open" onClick={() => { openEditor(company.id) }}>{company.display_name}</button>
              {company.legal_name && company.legal_name !== company.display_name && <span className="companies-table__legal">{company.legal_name}</span>}
            </span>
          </span>
        </td>
        <td>
          <StatusBadge tone={FILE_STATUS_TONES[company.status]}>{FILE_STATUS_LABELS[company.status]}</StatusBadge>
          <LifecycleBadge block={company.block} />
          {company.missing.length > 0 && <span className="companies-table__legal">Manque : {missingText(company.missing)}</span>}
        </td>
        <td>{company.company_kind ? COMPANY_KIND_LABELS[company.company_kind] : 'À classer'}</td>
        <td className="companies-table__id companies-col--siren">{company.siren ? formatSiren(company.siren) : '—'}</td>
        <td className="companies-col--domain">{company.email_domain ?? '—'}</td>
        <td className="companies-col--city">{company.city ?? '—'}</td>
        <td className="companies-col--segment">{company.commercial_segment_label ?? '—'}</td>
        <td className="table__numeric">{company.establishment_count}</td><td className="table__numeric">{company.prospect_count}</td>
        <td className="row-actions">{rowMenu.button(company)}</td>
      </tr>)}</tbody>
    </Table>
    {rowMenu.menu}
    {lifecycle.dialog}
    {deleting && <ConfirmDelete title="Supprimer cette entreprise ?" confirmLabel="Supprimer l’entreprise" pending={remove.isPending} error={remove.error} onClose={() => { remove.reset(); setDeleting(null) }} onConfirm={() => { remove.mutate(deleting.id, { onSuccess: () => { setDeleting(null) } }) }}>
      <p>« {deleting.display_name} » est supprimée avec ses établissements. Impossible tant que des prospects lui sont rattachés.</p>
    </ConfirmDelete>}
  </div>
}
