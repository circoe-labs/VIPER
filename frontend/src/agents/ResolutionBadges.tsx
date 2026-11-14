import type { ProposalResolution } from '../api/agents'
import { StatusBadge } from '../ui/Badge'
import { InfoTip } from '../ui/InfoTip'

// What VIPER will really write for a referential value (role, segment, activity category): « Associé » when the
// agent's wording was matched to an existing value, « New » when it will be added to the list on validation.
// Exact matches say nothing (nothing was transformed).
export function ResolutionBadges({ resolutions }: { resolutions: ProposalResolution[] | undefined }) {
  const notable = (resolutions ?? []).filter((resolution) => resolution.kind !== 'exact')
  if (notable.length === 0) return null
  return (
    <>
      {notable.map((resolution) => (
        <span key={resolution.raw_value} className="resolution-badge">
          <StatusBadge tone={resolution.kind === 'new' ? 'info' : 'success'}>
            {resolution.kind === 'new' ? 'New' : 'Associé'}
          </StatusBadge>
          <InfoTip label={`Aide : ${resolution.raw_value}`}>
            {resolution.kind === 'new' ? (
              <>
                Valeur de l’agent : « {resolution.raw_value} ». Cette valeur n’existe pas dans VIPER : elle sera
                ajoutée au référentiel lors de la validation de ce résultat.
              </>
            ) : (
              <>
                Valeur de l’agent : « {resolution.raw_value} ». VIPER l’a associée à « {resolution.resolved_value} ».
              </>
            )}
          </InfoTip>
        </span>
      ))}
    </>
  )
}
