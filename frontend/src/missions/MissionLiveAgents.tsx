import type { LiveAgentRef } from '../api/missions'
import { Avatar } from '../ui/Avatar'
import { Tooltip } from '../ui/Tooltip'
import './missionsList.css'

const SHOWN_MAX = 3

function detail(agent: LiveAgentRef): string {
  return agent.owner_name ? `${agent.agent_label} travaille pour ${agent.owner_name}` : `${agent.agent_label} travaille`
}

// The agents working on the mission right now (active only; the Activité tab holds the full history): a chip per
// agent, the avatar of the person it acts for with a pulsing blue ring, three at most then « +N ». Nothing at all when
// none is active.
export function MissionLiveAgents({ agents }: { agents: LiveAgentRef[] | undefined }) {
  if (!agents || agents.length === 0) return null
  const shown = agents.slice(0, SHOWN_MAX)
  const rest = agents.slice(SHOWN_MAX)
  return (
    <ul className="mlist-live" aria-label="Agents au travail">
      {shown.map((agent) => (
        <li key={agent.agent_id}>
          <Tooltip className="mlist-live__chip" content={detail(agent)} focusable>
            <Avatar name={agent.owner_name ?? agent.agent_label} size="xs" working />
            <span className="mlist-live__name">{agent.agent_label}</span>
          </Tooltip>
        </li>
      ))}
      {rest.length > 0 && (
        <li>
          <Tooltip
            className="mlist-live__chip mlist-live__chip--more"
            focusable
            content={rest.map((agent) => agent.agent_label).join(', ')}
          >
            {`+${String(rest.length)}`}
          </Tooltip>
        </li>
      )}
    </ul>
  )
}
