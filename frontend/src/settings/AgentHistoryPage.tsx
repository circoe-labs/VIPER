import { PageHeader } from '../ui/PageHeader'
import { McpCallsCard } from './McpCallsCard'
import './settings.css'

// « Historique agents »: every MCP call, under the e-mail of the person the agent acts for — its own entry in the
// navigation so the trail of what agents did is one click away (also shown in Paramètres > MCP).
export function AgentHistoryPage() {
  return (
    <>
      <PageHeader
        title="Historique des agents"
        description="Chaque appel d’outil MCP fait par un agent : qui (e-mail du propriétaire), quel agent, quel outil, avec quels paramètres, le résultat et la durée."
      />
      <McpCallsCard />
    </>
  )
}
