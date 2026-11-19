import { Link, Navigate, useParams } from 'react-router'

import { useMcpSettings } from '../api/mcpSettings'
import { useToolboxStatus } from '../api/toolbox'
import { StatusBadge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { McpSection } from '../settings/McpSection'
import { PromptSection } from '../settings/PromptSection'
import { ConnectionsSection } from './ConnectionsSection'
import { ScoringSection } from './ScoringSection'
import { STATE_BADGES } from '../settings/toolboxCopy'
import '../settings/settings.css'

// `connections` (the default tab) is also the OAuth return page of the CIRCOE Toolbox (`/settings/connections`
// redirects here, query kept). Only real separate concerns stay tabs: MCP, Prompt, Scoring prospect.
const SECTIONS = {
  connections: { title: 'Connexions', Section: ConnectionsSection },
  mcp: { title: 'MCP', Section: McpSection },
  prompt: { title: 'Prompt', Section: PromptSection },
  scoring: { title: 'Scoring prospect', Section: ScoringSection },
} as const

// Former tabs now folded into a connection of the grid.
const FORMER_TABS = { calendly: 'calendly', humanizer: 'humangpt' } as const

type SectionId = keyof typeof SECTIONS
const ORDER = Object.keys(SECTIONS) as SectionId[]

// Administration > Config AI: what makes the AI side of VIPER work (technical connections, MCP tools, the prompts).
// Business lists stay in Paramètres. Administrators only (guarded in routes.tsx).
export function ConfigAiPage() {
  const { section = 'connections' } = useParams()
  // The mission assistant's prompt lives in « Prompt » (older links point to its former tab).
  if (section === 'mission-creator') return <Navigate to="/config-ai/prompt" replace />
  // Calendly and HumanGPT are connections like the others: their former tabs open their dialog in the grid.
  if (section in FORMER_TABS) return <Navigate to={`/config-ai/connections?open=${FORMER_TABS[section as keyof typeof FORMER_TABS]}`} replace />
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
