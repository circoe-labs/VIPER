import { type McpParameter, type McpTool, useMcpSettings } from '../api/mcpSettings'
import { Badge } from '../ui/Badge'
import { Card } from '../ui/Card'
import './settings.css'

function ParameterRow({ parameter }: { parameter: McpParameter }) {
  return (
    <li className="mcp-param">
      <div className="mcp-param__head">
        <code className="mcp-param__name">{parameter.name}</code>
        <span className="mcp-param__type">{parameter.type}</span>
        {parameter.required ? <Badge tone="accent">obligatoire</Badge> : <span className="mcp-param__optional">facultatif</span>}
      </div>
      {parameter.description && <p className="mcp-param__description">{parameter.description}</p>}
      {parameter.enum && (
        <p className="mcp-param__enum">
          Valeurs : {parameter.enum.map((value) => `« ${value} »`).join(', ')}
        </p>
      )}
    </li>
  )
}

function ToolCard({ tool }: { tool: McpTool }) {
  return (
    <Card>
      <div className="mcp-tool">
        <div className="mcp-tool__head">
          <code className="mcp-tool__name">{tool.name}</code>
          <span className="mcp-tool__count">
            {tool.parameters.length === 0
              ? 'aucun paramètre'
              : `${String(tool.parameters.length)} paramètre${tool.parameters.length > 1 ? 's' : ''}`}
          </span>
        </div>
        <p className="mcp-tool__description">{tool.description}</p>
        {tool.parameters.length > 0 && (
          <ul className="mcp-params">
            {tool.parameters.map((parameter) => (
              <ParameterRow key={parameter.name} parameter={parameter} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

// Paramètres > MCP: what an agent can call, and with which parameters. Nothing to edit — the tools are the code
// (`app/api/mcp.py`), and a token is minted from the command line.
export function McpSection() {
  const settings = useMcpSettings()

  if (settings.isLoading) return <p className="settings-muted">Chargement…</p>
  if (settings.isError || !settings.data) {
    return <p className="settings-error">Les outils MCP n’ont pas pu être chargés.</p>
  }

  return (
    <div className="mcp">
      <p className="mcp-lead">
        Les agents se connectent au serveur MCP de VIPER sur <code>{settings.data.endpoint}</code> (protocole{' '}
        <code>{settings.data.protocol_version}</code>), avec un jeton d’accès créé en ligne de commande. Aucun de ces
        outils n’écrit dans la base : une soumission devient une proposition que vous validez dans Missions.
      </p>
      <div className="mcp-tools">
        {settings.data.tools.map((tool) => (
          <ToolCard key={tool.name} tool={tool} />
        ))}
      </div>
    </div>
  )
}
