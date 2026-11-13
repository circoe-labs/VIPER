import type { MissionStatistics } from '../api/missions'
import { UsersIcon } from '../ui/icons'
import { Table } from '../ui/Table'
import { MissionDonut } from './MissionDonut'
import { MissionPanel } from './MissionPanel'
import { agentAcceptanceRate, formatCount, formatRate } from './statsModel'
import { agentActivityDonut } from './statsSelectors'
import './statsPanels.css'

// « Répartition de l'activité par agent »: part of the journal entries written by each agent (`agents[].logs`).
// Unit is « entrées » (journal), never « appels »: the telemetry has no call counter (CONTRACT.md D3).
export function AgentDonutPanel({ stats }: { stats: MissionStatistics }) {
  return (
    <MissionPanel title="Répartition de l’activité par agent" icon={UsersIcon} hue="green">
      <MissionDonut
        title="Répartition de l’activité par agent"
        segments={agentActivityDonut(stats)}
        unit="entrées"
        emptyText="Aucun agent n’a encore écrit dans le journal de cette mission."
      />
    </MissionPanel>
  )
}

const HEADS = ['Sessions', 'Journaux', 'Résultats', 'Acceptés', 'Refusés', 'À relire', 'Taux d’acceptation']

// Table alternative and detail of the donut: one row per agent, every `AgentStats` field.
export function AgentTablePanel({ stats }: { stats: MissionStatistics }) {
  return (
    <MissionPanel title="Par agent" icon={UsersIcon} hue="blue">
      {stats.agents.length === 0 ? (
        <p className="mui-state">Aucun agent n’a encore travaillé sur cette mission.</p>
      ) : (
        <Table caption="Statistiques par agent (toute la mission)" density="compact">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              {HEADS.map((head) => (
                <th scope="col" key={head} className="mui-num">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.agents.map((agent) => (
              <tr key={agent.agent_id}>
                <th scope="row">{agent.agent_label}</th>
                <td className="mui-num">{formatCount(agent.sessions)}</td>
                <td className="mui-num">{formatCount(agent.logs)}</td>
                <td className="mui-num">{formatCount(agent.results)}</td>
                <td className="mui-num">{formatCount(agent.accepted)}</td>
                <td className="mui-num">{formatCount(agent.rejected)}</td>
                <td className="mui-num">{formatCount(agent.pending_review)}</td>
                <td className="mui-num">{formatRate(agentAcceptanceRate(agent))}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </MissionPanel>
  )
}
