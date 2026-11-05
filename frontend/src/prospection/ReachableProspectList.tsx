import { useId, useState } from 'react'
import { Link } from 'react-router'
import type { ProspectRow } from '../api/prospection'
import { COMPANY_KIND_LABELS } from '../api/companies'
import { ScoreRing } from '../ui/ScoreRing'
import { BAND_TONES, DATA_QUALITY_LABELS } from '../prospects/scoreView'
import { BanIcon, BuildingIcon, CheckIcon, ChevronRightIcon } from '../ui/icons'
import { personName, formatPhone } from './labels'
import { ServiceInterestEditor } from './ServiceInterestEditor'
import { SERVICES } from './services'

export function ReachableProspectList({ rows, openHref }: { rows: ProspectRow[]; openHref: (id: string) => string }) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(() => new Set())
  const contactsId = useId()
  const grouped = new Map<string, { company: string; contacts: ProspectRow[] }>()
  for (const row of rows) {
    const key = row.company_id ?? 'no-company'
    const group = grouped.get(key)
    if (group) group.contacts.push(row)
    else grouped.set(key, { company: row.company_name ?? 'Sans entreprise', contacts: [row] })
  }
  return (
    <>
      <div
        className="prospect-table-scroll"
        role="region"
        aria-label="Tableau des prospects, défilement horizontal"
        tabIndex={0}
      >
        <table className="prospect-table" aria-label="Prospects">
          <thead>
            <tr>
              <th scope="col">Contact</th>
              <th scope="col">Catégorie</th>
              <th scope="col">Statut d’envoi</th>
              <th scope="col">Statut du prospect</th>
              <th scope="col">Fiabilité</th>
              {SERVICES.map(({ code, label }) => (
                <th scope="col" key={code} className={`service-column service-choice--${code}`}>
                  {label}
                </th>
              ))}
              <th scope="col">
                <span className="visually-hidden">Ouvrir la fiche</span>
              </th>
            </tr>
          </thead>
          {[...grouped].map(([key, group]) => {
            const expanded = expandedCompanies.has(key)
            return <tbody key={key} aria-label={group.company}>
            <tr className="prospect-company-group">
              <th scope="rowgroup" colSpan={11}>
                <button
                  type="button"
                  className="prospect-company-toggle"
                  aria-expanded={expanded}
                  aria-controls={group.contacts.map((row) => `${contactsId}-${row.id}`).join(' ')}
                  aria-label={`${expanded ? 'Masquer' : 'Afficher'} les contacts de ${group.company}`}
                  onClick={() => {
                    setExpandedCompanies((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }}
                >
                  <ChevronRightIcon size={16} className="prospect-company-chevron" />
                  <BuildingIcon size={17} />
                  <span>{group.company}</span>
                </button>
              </th>
            </tr>
            {group.contacts.map((row) => {
              const name = personName(row)
              const company = row.company_name ?? name
              const validated = row.employment_verified_at !== null && row.review !== 'ignored'
              const review = validated ? 'Validé' : { verified: 'Validé', to_verify: 'Incertain', ignored: 'Ignoré' }[row.review]
              const tone = validated ? 'green' : { verified: 'green', to_verify: 'yellow', ignored: 'red' }[row.review]
              const send = row.send_stage
              return (
                <tr key={row.id} id={`${contactsId}-${row.id}`} data-prospect-id={row.id} hidden={!expanded}>
                  <td>
                    <div className="prospect-identity">
                      <span className="prospect-avatar" aria-hidden="true">
                        {name.trim()[0]?.toUpperCase() ?? '?'}
                      </span>
                      <div>
                        <Link
                          className="prospect-company-link"
                          to={openHref(row.id)}
                          aria-label={name}
                          title={`Ouvrir ${name}`}
                        >
                          {name}
                        </Link>
                        <span className="prospect-email">{row.primary_email ?? 'E-mail non renseigné'}</span>
                    {row.primary_phone && <span className="prospect-person">{formatPhone(row.primary_phone)}</span>}
                        {row.contactability_status === 'do_not_contact' && (
                          <span className="prospect-opposition">
                            <BanIcon size={12} />
                            Ne pas contacter
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    {row.review === 'ignored' ? (
                      <span className="table-muted">Prospect ignoré</span>
                    ) : row.company_kind ? (
                      <span className={`dashboard-badge category-${row.company_kind}`}>
                        {row.company_kind === 'large'
                          ? 'Grosses entreprises'
                          : COMPANY_KIND_LABELS[row.company_kind]}
                      </span>
                    ) : (
                      <span
                        className="table-muted"
                        title="Aucune catégorie métier confirmée pour cette entreprise"
                      >
                        À renseigner
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`dashboard-badge tone-${send === 'sent' ? 'blue' : send === 'r1' ? 'green' : send === 'r2' ? 'yellow' : 'neutral'}`}
                      title={
                        send === 'r2'
                          ? 'Deuxième relance atteinte. Consulter la fiche pour l’historique complet.'
                          : undefined
                      }
                    >
                      {send ? { sent: 'Envoyé', r1: 'R1', r2: 'R2' }[send] : 'Non envoyé'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`dashboard-badge tone-${tone}`}
                        title={validated ? 'Fiche validée dans Vérification ; la vérification de l’e-mail est distincte.' : undefined}
                    >
                      <span aria-hidden="true">●</span>
                      {review}
                    </span>
                  </td>
                  <td>
                    {row.quality_score != null && row.quality_band ? (
                      <span
                        className="table-quality"
                        title={`Qualité des données : ${DATA_QUALITY_LABELS[row.quality_band]}`}
                      >
                        <ScoreRing value={row.quality_score} tone={BAND_TONES[row.quality_band]} />
                        <span>{row.quality_score} %</span>
                      </span>
                    ) : (
                      <span className="table-muted">
                        {row.contactability_status === 'do_not_contact' ? 'Écarté' : 'Indisponible'}
                      </span>
                    )}
                  </td>
                  {SERVICES.map(({ code, label }) => {
                    const selected = row.proposed_services?.includes(code) ?? false
                    return (
                      <td className={`service-cell service-choice--${code}`} key={code}>
                        {row.company_id ? (
                          <button
                            type="button"
                            title={`Modifier les prestations de ${company}`}
                            aria-label={`${label} · ${company} : ${selected ? 'besoin identifié' : 'non renseigné'}. Modifier les prestations`}
                            onClick={() => {
                              if (row.company_id) setEditing({ id: row.company_id, name: company })
                            }}
                          >
                            {selected ? <CheckIcon size={18} /> : <span className="table-muted">—</span>}
                          </button>
                        ) : (
                          <span className="table-muted" title="Associez une entreprise depuis la fiche">
                            —
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td>
                    <Link className="table-open" aria-label={`Fiche de ${name}`} to={openHref(row.id)}>
                      <ChevronRightIcon size={18} />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>})}
        </table>
      </div>
      {editing && (
        <ServiceInterestEditor
          id={editing.id}
          name={editing.name}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
    </>
  )
}
