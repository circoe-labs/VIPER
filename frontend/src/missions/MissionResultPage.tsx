import { Link, useParams } from 'react-router'

import { type ProposalItem, useResult } from '../api/agents'
import { useMission } from '../api/missions'
import { ArrowLeftIcon, CheckCircleIcon } from '../ui/icons'
import './missions.css'

const FIELD_MATCHERS: Record<'role' | 'email' | 'linkedin' | 'city', RegExp> = {
  role: /role|job|fonction|title|poste/i,
  email: /mail/i,
  linkedin: /linkedin/i,
  city: /city|ville/i,
}

function valueOf(items: ProposalItem[], matcher: RegExp): string | null {
  const item = items.find((candidate) => matcher.test(candidate.field))
  const value = item?.after
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

// One proposed record, laid out as the « Résultat mission » card: score badge, then one line per field (— when the
// agent proposed nothing for it).
function ResultCard({ resultId }: { resultId: string }) {
  const result = useResult(resultId).data
  if (!result) return <p className="missions-muted">Chargement…</p>
  const items = result.proposal.items
  const rows: [string, string | null][] = [
    ['Nom', result.prospect_name],
    ['Fonction', valueOf(items, FIELD_MATCHERS.role)],
    ['Mail', valueOf(items, FIELD_MATCHERS.email)],
    ['LinkedIn', valueOf(items, FIELD_MATCHERS.linkedin)],
    ['Société', result.company_name],
    ['Ville', valueOf(items, FIELD_MATCHERS.city)],
    ['IA', result.submitted_by_label],
  ]
  const score = Math.round(result.proposal.confidence * 100)
  return (
    <article className="mission-result-card">
      <span className="mission-result-card__score">score{Number.isFinite(score) ? ` ${String(score)}` : ''}</span>
      <dl className="mission-result-card__rows">
        {rows.map(([label, value]) => (
          <div key={label} className="mission-result-card__row">
            <dt>{label}</dt>
            <dd>{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

// « Résultat mission »: where the creation form leads. One card per result the agents have submitted so far.
export function MissionResultPage() {
  const { missionId } = useParams()
  const mission = useMission(missionId)
  const resultIds = (mission.data?.tasks ?? []).flatMap((task) => (task.result_id ? [task.result_id] : []))
  return (
    <div className="missions mission-result">
      <Link to={missionId ? `/missions/${missionId}` : '/missions'} className="missions-back">
        <ArrowLeftIcon size={16} /> {mission.data?.card.name ?? 'Missions'}
      </Link>
      <h1 className="mission-result__title">
        <CheckCircleIcon size={40} /> Résultat mission
      </h1>
      {mission.isLoading ? (
        <p className="missions-muted">Chargement…</p>
      ) : mission.isError || !mission.data ? (
        <p className="missions-error" role="alert">
          Mission introuvable.
        </p>
      ) : resultIds.length === 0 ? (
        <article className="mission-result-card">
          <span className="mission-result-card__score">score</span>
          <p className="missions-muted">
            Aucun résultat pour l’instant : ils apparaîtront ici dès que l’agent aura répondu.
          </p>
        </article>
      ) : (
        resultIds.map((id) => <ResultCard key={id} resultId={id} />)
      )}
    </div>
  )
}
