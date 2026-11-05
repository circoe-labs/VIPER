import { COMPANY_KIND_LABELS, type CompanyListItem } from '../api/companies'
import { Table } from '../ui/Table'
import { useCompanyEditor } from './CompanyEditorProvider'
import { formatSiren } from './companyForm'

export function CompanyTable({ items }: { items: CompanyListItem[] }) {
  const openEditor = useCompanyEditor()
  return <Table caption="Liste des entreprises">
    <thead><tr>
      <th scope="col">Entreprise</th><th scope="col">Type</th><th scope="col">SIREN</th>
      <th scope="col">Domaine e-mail</th><th scope="col">Ville</th><th scope="col">Segment</th>
      <th scope="col" className="table__numeric">Établissements</th>
      <th scope="col" className="table__numeric">Prospects</th>
    </tr></thead>
    <tbody>{items.map((company) => <tr key={company.id}>
      <td><button type="button" className="companies-table__open" onClick={() => { openEditor(company.id) }}>{company.display_name}</button>
        {company.legal_name && company.legal_name !== company.display_name && <span className="companies-table__legal">{company.legal_name}</span>}
      </td>
      <td>{company.company_kind ? COMPANY_KIND_LABELS[company.company_kind] : 'À classer'}</td>
      <td className="companies-table__id">{company.siren ? formatSiren(company.siren) : '—'}</td>
      <td>{company.email_domain ?? '—'}</td><td>{company.city ?? '—'}</td><td>{company.commercial_segment_label ?? '—'}</td>
      <td className="table__numeric">{company.establishment_count}</td><td className="table__numeric">{company.prospect_count}</td>
    </tr>)}</tbody>
  </Table>
}
