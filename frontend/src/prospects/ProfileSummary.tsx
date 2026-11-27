import { useState } from 'react'
import { useCompany } from '../api/companies'
import type { Prospect, ProspectScore } from '../api/prospects'
import { useTaxonomyValues } from '../api/settings'
import { civilityLabel, stateLabel } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { BanIcon, CopyIcon, FileTextIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import type { CompletenessView, IndicatorState, ProximityView } from './indicators'
import type { AliasDraft, ProspectDraft } from './prospectForm'
import { proximityLabel } from './proximityView'
import { BAND_LABELS } from './scoreView'
import { isEvaluated } from './ScoreEvaluation'
import { summarizeProspect, type SummaryEmail } from './sheetSummary'
import { aliasState } from './verification'
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
  // The score as the Score prospect card shows it (an evaluation may have changed it since the prospect was loaded).
  score: ProspectScore | null
  draft: ProspectDraft
  prospect: Prospect | null
  labels: EmploymentLabels
  // What the synthesis reads: the indicators the sheet already shows (never recomputed here).
  completeness: IndicatorState<CompletenessView>
  proximity: IndicatorState<ProximityView>
  companyMoved: boolean
  today: string
}

// « Résumé » card (Profil tab): a short synthesis of the real data of the sheet — role at company, fiche state, e-mail
// verification, proximity, score status — derived from the editor's draft and indicators, never a second copy: a pending
// edit shows here as soon as it is typed. The person's name is in the header, not repeated here.
export function ProfileSummary({ draft, prospect, score, labels, completeness, proximity, companyMoved, today }: ProfileSummaryProps) {
  const [copyStatus, setCopyStatus] = useState('')
  const name = [civilityLabel(draft.civility || null), draft.first_name.trim(), draft.last_name.trim()].filter(Boolean).join(' ')
  const email = mainAlias(draft.emails)
  const phone = mainAlias(draft.phones)
  const tracking = stateLabel(draft.tracking.status || null)
  const blocked = prospect?.contactability_status === 'do_not_contact'
  let emailStatus: SummaryEmail = 'none'
  if (email.alias) {
    const tone = aliasState(email.alias, { kind: 'emails', companyMoved, today, staleDays: prospect?.stale_threshold_days ?? null }).tone
    emailStatus = tone === 'success' ? 'verified' : tone === 'danger' ? 'invalid' : 'unverified'
    const typed = email.alias.value.trim().toLowerCase()
    if (prospect?.emails.some((stored) => stored.identity_doubt && stored.address === typed)) emailStatus = 'doubtful'
  }
  const lines = summarizeProspect({
    role: labels.role,
    company: labels.company,
    ficheLabel: completeness.status === 'ready' ? completeness.value.label : null,
    email: emailStatus,
    proximity:
      proximity.status === 'ready'
        ? { state: proximity.value.state, pathCount: proximity.value.pathCount, label: proximityLabel(proximity.value.total) }
        : null,
    score: score ? { evaluated: isEvaluated(score), bandLabel: BAND_LABELS[score.band] } : null,
  })
  return (
    <EditorSection
      title="Résumé"
      label="Résumé du profil"
      icon={FileTextIcon}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={CopyIcon}
          onClick={() => {
            const copy = [
              `Nom : ${name || 'Non renseigné'}`,
              `Entreprise : ${labels.company || 'Non renseignée'}`,
              `Rôle : ${labels.role || 'Non renseigné'}`,
              `E-mail : ${email.alias?.value.trim() || 'Non renseigné'}`,
              `Téléphone : ${phone.alias?.value.trim() || 'Non renseigné'}`,
              ...(blocked ? ['Ne pas contacter'] : []),
              ...(tracking ? [`Suivi : ${tracking}`] : []),
            ]
            // A missing clipboard (insecure context) throws inside the chain: it is reported like a refused write.
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(copy.join('\n')))
              .then(
                () => {
                  setCopyStatus('Fiche copiée')
                },
                () => {
                  setCopyStatus('Copie impossible : sélectionnez le texte pour le copier.')
                },
              )
          }}
        >
          Copier les informations
        </Button>
      }
    >
      <div className="prospect-summary">
        {lines.map((line) => (
          <p key={line} className="prospect-summary__line">
            {line}
          </p>
        ))}
        {blocked && (
          <div className="prospect-summary__status">
            <StatusBadge tone="danger" icon={BanIcon}>
              Ne pas contacter
            </StatusBadge>
          </div>
        )}
        <span role="status" className="prospect-summary__copy-status">
          {copyStatus}
        </span>
      </div>
    </EditorSection>
  )
}
