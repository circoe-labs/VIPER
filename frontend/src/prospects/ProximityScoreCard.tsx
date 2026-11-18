import { ApiError } from '../api/client'
import { type Proximity, useProspectProximity } from '../api/proximity'
import { Button } from '../ui/Button'
import { ScoreRing } from '../ui/ScoreRing'
import { EditorSection } from './EditorSection'
import { describePath, hopsLabel, proximityLabel, proximityTone } from './proximityView'
import './proximity-score.css'

interface ProximityScoreCardProps {
  prospectId: string
}

// « Score de proximité » card (S3, standalone: S1 places it in the indicator strip). How directly the members of the
// organisation reach this prospect through the relations graph, explained by the best paths. Never part of the
// commercial-fit « Score prospect ». States: loading, error (with retry), empty (no relation), unreachable (relations
// that reach no member), reachable.
export function ProximityScoreCard({ prospectId }: ProximityScoreCardProps) {
  const query = useProspectProximity(prospectId)
  return (
    <div className="proximity-slot" data-slot="proximity-score">
      <EditorSection title="Score de proximité">
        <div className="proximity" aria-busy={query.isPending}>
          {query.isPending && (
            <p className="proximity__state" role="status">
              Calcul de la proximité…
            </p>
          )}
          {query.isError && (
            <div className="proximity__state" role="alert">
              <p>
                Le score de proximité n’a pas pu être calculé
                {query.error instanceof ApiError ? ` (${query.error.message})` : ''}.
              </p>
              <Button
                type="button"
                onClick={() => {
                  void query.refetch()
                }}
              >
                Réessayer
              </Button>
            </div>
          )}
          {query.data && <ProximityBody proximity={query.data} />}
        </div>
      </EditorSection>
    </div>
  )
}

function ProximityBody({ proximity }: { proximity: Proximity }) {
  if (proximity.state === 'empty') {
    return <p className="proximity__state">Aucune relation enregistrée : proximité inconnue.</p>
  }
  if (proximity.state === 'unreachable') {
    return (
      <p className="proximity__state">
        Aucun membre Circoe n’est relié à ce prospect (au plus {proximity.max_hops} liens).
      </p>
    )
  }
  const members = proximity.members.map((item) => item.member.name).join(', ')
  return (
    <>
      <div
        className="proximity__head"
        role="group"
        aria-label={`Score de proximité : ${String(proximity.score)} sur 100, ${proximityLabel(proximity.score).toLowerCase()}`}
      >
        <ScoreRing value={proximity.score} tone={proximityTone(proximity.score)} />
        <div className="proximity__text">
          <span className="proximity__band">{proximityLabel(proximity.score)}</span>
          <span className="proximity__summary">
            {proximity.path_count} chemin{proximity.path_count > 1 ? 's' : ''} · {members}
          </span>
        </div>
      </div>
      <ol className="proximity__paths" aria-label="Meilleurs chemins">
        {proximity.paths.map((path, index) => (
          <li key={index} className="proximity__path">
            <span className="proximity__path-meta">
              {hopsLabel(path.hops)} · force {path.strength}
            </span>
            <span className="proximity__path-text">{describePath(path)}</span>
          </li>
        ))}
      </ol>
    </>
  )
}
