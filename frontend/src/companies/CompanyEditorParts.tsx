import type { ReactNode } from 'react'

import {
  type ActivityStatus,
  type Company,
  type ProspectSummary,
  type SimilarityReason,
  useCompanyMutations,
  useSimilarCompanies,
} from '../api/companies'
import { useDebouncedValue } from '../settings/shared'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, InfoIcon } from '../ui/icons'
import { type CompanyDraft, normalizeEmailDomain } from './companyForm'
import { companyRefusal } from './messages'

// One editor section: a named region whose heading may carry a count.
export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="company-editor__section" aria-label={title}>
      <h3 className="company-editor__section-title">
        {title}
        {count !== undefined && <span className="company-editor__count">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

const REASONS: Record<SimilarityReason, string> = {
  same_company_name: 'même nom',
  similar_company_name: 'nom proche',
  same_email_domain: 'même domaine e-mail',
}

// "Does this company already exist?": while a new company is typed, existing ones with the same name key (legal forms,
// accents, punctuation ignored), a close spelling or the same e-mail domain. A warning only; nothing is refused.
export function SimilarCompanies({ draft, onOpen }: { draft: CompanyDraft; onOpen: (id: string) => void }) {
  const name = useDebouncedValue(draft.display_name.trim(), 300)
  const domain = useDebouncedValue(normalizeEmailDomain(draft.email_domain), 300)
  const similar = useSimilarCompanies(name, domain, null)
  const found = name.length >= 3 || domain ? (similar.data ?? []) : []
  if (found.length === 0) return null
  return (
    <div className="company-similar" role="note" aria-label="Entreprises proches déjà enregistrées">
      <p className="company-similar__title">
        <InfoIcon size={18} />
        Entreprises proches déjà enregistrées : vérifiez qu’il ne s’agit pas de la même.
      </p>
      <ul className="company-similar__list">
        {found.map((company) => (
          <li key={company.id} className="company-similar__item">
            <span>
              <strong>{company.display_name}</strong>
              <span className="company-editor__muted">
                {' — '}
                {company.reasons.map((reason) => REASONS[reason]).join(', ')}
                {company.email_domain ? ` · ${company.email_domain}` : ''}
              </span>
            </span>
            <Button
              size="sm"
              onClick={() => {
                onOpen(company.id)
              }}
            >
              Ouvrir « {company.display_name} »
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const ACTIVITY: Record<ActivityStatus, { tone: 'success' | 'neutral'; label: string }> = {
  active: { tone: 'success', label: 'Actif' },
  inactive: { tone: 'neutral', label: 'Inactif' },
  unknown: { tone: 'neutral', label: 'Activité inconnue' },
}

function prospectName(prospect: ProspectSummary): string {
  const civility = prospect.civility === 'mr' ? 'M.' : prospect.civility === 'ms' ? 'Mme' : ''
  return [civility, prospect.first_name, prospect.last_name].filter(Boolean).join(' ')
}

// The company's people, for navigation (the Prospect editor, Task 15, will open them). Read-only here: contact data and
// tracking belong to the prospect.
export function ProspectsSection({ company }: { company: Company }) {
  const { prospects, prospect_count: count } = company
  return (
    <Section title="Prospects associés" count={count}>
      {count === 0 ? (
        <p className="company-editor__muted">Aucun prospect n’est rattaché à cette entreprise.</p>
      ) : (
        <>
          <ul className="company-prospects">
            {prospects.map((prospect) => {
              const activity = ACTIVITY[prospect.activity_status]
              const role = [prospect.role_label, prospect.exact_job_title].filter(Boolean).join(' · ')
              return (
                <li key={prospect.id} className="company-prospects__item">
                  <span className="company-prospects__name">{prospectName(prospect)}</span>
                  <span className="company-prospects__role">{role || 'Rôle non renseigné'}</span>
                  <span className="company-prospects__badges">
                    <StatusBadge tone={activity.tone}>{activity.label}</StatusBadge>
                    {prospect.contactability_status === 'do_not_contact' && (
                      <StatusBadge tone="danger">Ne pas contacter</StatusBadge>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
          {count > prospects.length && (
            <p className="company-editor__muted">
              {prospects.length} premiers prospects affichés sur {count}.
            </p>
          )}
        </>
      )}
    </Section>
  )
}

interface DeleteCompanyDialogProps {
  company: Company
  onClose: () => void
  onDeleted: () => void
}

// Deleting is possible only while no prospect references the company (the server checks again).
export function DeleteCompanyDialog({ company, onClose, onDeleted }: DeleteCompanyDialogProps) {
  const { remove } = useCompanyMutations()
  const count = company.prospect_count
  const blocked = count > 0
  const establishments = company.establishments.length
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={blocked ? 'Suppression impossible' : `Supprimer « ${company.display_name} » ?`}
      footer={
        <>
          <Button onClick={onClose}>{blocked ? 'Fermer' : 'Annuler'}</Button>
          {!blocked && (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                remove.mutate(company.id, { onSuccess: onDeleted })
              }}
            >
              Supprimer
            </Button>
          )}
        </>
      }
    >
      <div className="company-editor__dialog">
        {blocked ? (
          <p>
            « {company.display_name} » est rattachée à {count} prospect{count > 1 ? 's' : ''}. Rattachez-les à une autre
            entreprise avant de la supprimer.
          </p>
        ) : (
          <p>
            {establishments === 0 && 'La fiche sera supprimée définitivement.'}
            {establishments === 1 && 'La fiche et son établissement seront supprimés définitivement.'}
            {establishments > 1 && `La fiche et ses ${String(establishments)} établissements seront supprimés définitivement.`}{' '}
            La suppression reste tracée dans l’historique.
          </p>
        )}
        {remove.isError && (
          <p className="company-editor__status company-editor__status--error" role="alert">
            <AlertIcon size={16} />
            {companyRefusal(remove.error).message}
          </p>
        )}
      </div>
    </Modal>
  )
}
