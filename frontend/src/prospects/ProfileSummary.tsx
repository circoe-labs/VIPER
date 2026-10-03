import { useCompany } from '../api/companies'
import type { Prospect } from '../api/prospects'
import { useTaxonomyValues } from '../api/settings'
import { civilityLabel, stateLabel } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { BanIcon, ClockIcon } from '../ui/icons'
import type { AliasDraft, ProspectDraft } from './prospectForm'
import './profile-summary.css'

export interface EmploymentLabels {
  company: string | null
  role: string | null
}

// The company and role names of the draft (what is chosen, not only what is stored): read by the summary and by the
// Emploi section's read view.
export function useEmploymentLabels(
  draft: Pick<ProspectDraft, 'company_id' | 'role_id' | 'role_label'> | undefined,
  prospect: Prospect | null,
): EmploymentLabels {
  const company = useCompany(draft?.company_id ?? null)
  const roles = useTaxonomyValues('roles')
  const storedCompany = prospect?.company && prospect.company.id === draft?.company_id ? prospect.company.display_name : null
  const storedRole = prospect?.role && prospect.role.id === draft?.role_id ? prospect.role.label : null
  return {
    company: company.data?.display_name ?? storedCompany,
    role: draft?.role_label ?? roles.data?.find((role) => role.id === draft?.role_id)?.label ?? storedRole,
  }
}

// The main address or number of the draft: the active primary one, else the first active one with a value.
export function mainAlias(aliases: AliasDraft[]): { alias: AliasDraft | null; others: number } {
  const usable = aliases.filter((alias) => alias.is_active && alias.value.trim())
  const alias = usable.find((candidate) => candidate.is_primary) ?? usable[0] ?? null
  return { alias, others: alias ? usable.length - 1 : 0 }
}

interface ProfileSummaryProps {
  draft: ProspectDraft
  prospect: Prospect | null
  labels: EmploymentLabels
}

// The person at a glance (Profil tab): a read view derived from the editor's draft, never a second copy — a pending
// edit shows here as soon as it is typed. Missing values say so instead of leaving a hole.
export function ProfileSummary({ draft, prospect, labels }: ProfileSummaryProps) {
  const name = [civilityLabel(draft.civility || null), draft.first_name.trim(), draft.last_name.trim()].filter(Boolean).join(' ')
  const email = mainAlias(draft.emails)
  const phone = mainAlias(draft.phones)
  const job = [labels.role, labels.company].filter(Boolean).join(' · ')
  const tracking = stateLabel(draft.tracking.status || null)
  const blocked = prospect?.contactability_status === 'do_not_contact'
  return (
    <section className="prospect-summary" aria-label="Résumé du profil">
      <div className="prospect-summary__who">
        <p className="prospect-summary__name">{name || 'Sans nom'}</p>
        <p className="prospect-summary__job" title={job || undefined}>
          {job || <span className="prospect-editor__muted">Entreprise et rôle non renseignés</span>}
        </p>
      </div>
      <dl className="prospect-summary__channels">
        <div>
          <dt>E-mail</dt>
          <dd>
            {email.alias ? (
              <>
                <span className="prospect-summary__value">{email.alias.value.trim()}</span>
                {email.others > 0 && <span className="prospect-editor__muted"> +{email.others}</span>}
              </>
            ) : (
              <span className="prospect-editor__muted">Aucun e-mail</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Téléphone</dt>
          <dd>
            {phone.alias ? (
              <>
                <span className="prospect-summary__value">{phone.alias.value.trim()}</span>
                {phone.others > 0 && <span className="prospect-editor__muted"> +{phone.others}</span>}
              </>
            ) : (
              <span className="prospect-editor__muted">Aucun téléphone</span>
            )}
          </dd>
        </div>
      </dl>
      {(tracking || blocked) && (
        <div className="prospect-summary__status">
          {blocked && (
            <StatusBadge tone="danger" icon={BanIcon}>
              Ne pas contacter
            </StatusBadge>
          )}
          {tracking && (
            <StatusBadge tone="info" icon={ClockIcon}>
              {tracking}
            </StatusBadge>
          )}
        </div>
      )}
    </section>
  )
}
