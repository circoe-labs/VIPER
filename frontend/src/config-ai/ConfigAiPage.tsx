import { Link, Navigate, useParams } from 'react-router'

import { useMcpSettings } from '../api/mcpSettings'
import { useToolboxStatus } from '../api/toolbox'
import { StatusBadge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { ConnectionsSection } from '../settings/ConnectionsSection'
import { McpSection } from '../settings/McpSection'
import { MissionCreatorPromptSection, PromptSection } from '../settings/PromptSection'
import { STATE_BADGES } from '../settings/toolboxCopy'
import '../settings/settings.css'

// `connections` is also the OAuth return page of the CIRCOE Toolbox (`/settings/connections` redirects here, query kept).
const SECTIONS = {
  connections: { title: 'Connexions', Section: ConnectionsSection },
  mcp: { title: 'MCP', Section: McpSection },
  prompt: { title: 'Prompt initial', Section: PromptSection },
  'mission-creator': { title: 'Assistant de mission', Section: MissionCreatorPromptSection },
} as const

type SectionId = keyof typeof SECTIONS
const ORDER = Object.keys(SECTIONS) as SectionId[]

// Administration > Config AI: what makes the AI side of VIPER work (technical connections, MCP tools, the prompts).
// Business lists stay in Paramètres. Administrators only (guarded in routes.tsx).
export function ConfigAiPage() {
  const { section = 'connections' } = useParams()
  if (!(section in SECTIONS)) return <Navigate to="/config-ai" replace />
  const current = section as SectionId
  const { title, Section } = SECTIONS[current]
  return (
    <>
      <PageHeader title="Config AI" />
      <nav className="settings-tabs" aria-label="Sections de la configuration AI">
        {ORDER.map((id) => (
          <Link
            key={id}
            to={`/config-ai/${id}`}
            className="settings-tabs__link"
            aria-current={id === current ? 'page' : undefined}
          >
            <span>{SECTIONS[id].title}</span>
            {id === 'mcp' && <McpCount />}
            {id === 'connections' && <ConnectionState />}
          </Link>
        ))}
      </nav>
      <section className="settings-panel" aria-label={title}>
        <Section />
      </section>
    </>
  )
}

function McpCount() {
  const total = useMcpSettings().data?.tools.length
  return total === undefined ? null : (
    <span className="settings-tabs__count">
      {total}
      <span className="visually-hidden"> valeurs</span>
    </span>
  )
}

// Only the state that asks for something is flagged on the tab.
function ConnectionState() {
  const state = useToolboxStatus().data?.state
  return state === 'expired' ? <StatusBadge tone="warning">{STATE_BADGES.expired.label}</StatusBadge> : null
}
