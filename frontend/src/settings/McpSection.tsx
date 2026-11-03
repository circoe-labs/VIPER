import { useState } from 'react'

import {
  type McpAgent,
  type McpParameter,
  type McpSettings,
  type McpTool,
  useMcpAgents,
  useMcpSettings,
  useRevokeMcpAgent,
} from '../api/mcpSettings'
import { formatDateTime } from '../contact/labels'
import { Badge, StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Modal } from '../ui/Dialog'
import { CreateAgentDialog, MODE_LABELS, PROVIDER_LABELS } from './McpAgentCreate'
import { McpCallsCard } from './McpCallsCard'
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

// How to plug a connector in: the full address, and what each client asks for.
function ConnectCard({ endpoint }: { endpoint: string }) {
  const url = `${window.location.origin}${endpoint}`
  return (
    <Card title="Connecter ChatGPT, Claude ou un autre client MCP">
      <div className="mcp-connect">
        <p className="mcp-connect__url">
          Adresse du serveur : <code>{url}</code>
        </p>
        <ul className="mcp-connect__steps">
          <li>
            <strong>ChatGPT</strong> (mode développeur) et <strong>claude.ai</strong> (connecteur personnalisé) : collez
            cette adresse et choisissez l’authentification <strong>OAuth</strong>. VIPER vous demande alors d’autoriser
            l’accès.
          </li>
          <li>
            <strong>Claude Code</strong> et les clients qui acceptent un en-tête : un jeton créé ci-dessous (« Créer un
            jeton ») ou en ligne de commande (<code>python -m app.cli create-agent-token --label …</code>), envoyé en{' '}
            <code>Authorization: Bearer …</code>.
          </li>
        </ul>
      </div>
    </Card>
  )
}

function lastUse(agent: McpAgent): string {
  if (agent.revoked_at) return `Révoqué le ${formatDateTime(agent.revoked_at)}`
  return agent.last_used_at ? `Dernière utilisation le ${formatDateTime(agent.last_used_at)}` : 'Jamais utilisé'
}

// What the agent may do, by the labels of Paramètres (its own capabilities, before its person's role).
function capabilityText(agent: McpAgent, settings: McpSettings): string {
  if (agent.capabilities.length === 0) return 'Aucune capacité'
  const labels = new Map(settings.capabilities.map((capability) => [capability.name, capability.label]))
  return agent.capabilities.map((name) => labels.get(name) ?? name).join(' · ')
}

// « Accès autorisés »: who may call /mcp, in which mode and with which capabilities; « Créer un jeton » and
// « Révoquer » (immediate, OAuth tokens included).
function AgentsCard({ settings }: { settings: McpSettings }) {
  const agents = useMcpAgents()
  const revoke = useRevokeMcpAgent()
  const [confirming, setConfirming] = useState<McpAgent | null>(null)
  const [creating, setCreating] = useState(false)
  return (
    <Card
      title="Accès autorisés"
      actions={
        <Button
          size="sm"
          onClick={() => {
            setCreating(true)
          }}
        >
          Créer un jeton
        </Button>
      }
    >
      {agents.isLoading && <p className="settings-muted">Chargement…</p>}
      {agents.isError && <p className="settings-error">Les accès n’ont pas pu être chargés.</p>}
      {agents.data?.length === 0 && <p className="settings-muted">Aucun accès pour l’instant.</p>}
      {agents.data && agents.data.length > 0 && (
        <ul className="mcp-agents">
          {agents.data.map((agent) => (
            <li key={agent.id} className="mcp-agent">
              <div className="mcp-agent__main">
                <span className="mcp-agent__label">{agent.label}</span>
                <span className="mcp-agent__meta">
                  {agent.origin === 'oauth' ? 'Connecteur OAuth' : 'Jeton d’accès'} · {PROVIDER_LABELS[agent.provider]}{' '}
                  · {MODE_LABELS[agent.mode]}
                  {agent.owner_email ? ` · pour ${agent.owner_email}` : ''} · créé le {formatDateTime(agent.created_at)}{' '}
                  · {lastUse(agent)}
                </span>
                <span className="mcp-agent__capabilities">{capabilityText(agent, settings)}</span>
              </div>
              {agent.revoked_at ? (
                <StatusBadge tone="neutral">Révoqué</StatusBadge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    revoke.reset()
                    setConfirming(agent)
                  }}
                >
                  Révoquer
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={confirming !== null}
        size="sm"
        title={`Révoquer « ${confirming?.label ?? ''} » ?`}
        onClose={() => {
          setConfirming(null)
        }}
        footer={
          <>
            <Button
              disabled={revoke.isPending}
              onClick={() => {
                setConfirming(null)
              }}
            >
              Retour
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() => {
                if (!confirming) return
                revoke.mutate(confirming.id, {
                  onSuccess: () => {
                    setConfirming(null)
                  },
                })
              }}
            >
              Révoquer l’accès
            </Button>
          </>
        }
      >
        <div className="settings-dialog">
          <p>
            Cet agent ne peut plus appeler le serveur MCP, immédiatement. Pour un connecteur (ChatGPT, Claude…), il faudra
            l’autoriser à nouveau depuis l’application.
          </p>
          {revoke.isError && (
            <p className="settings-error" role="alert">
              L’accès n’a pas pu être révoqué : réessayez.
            </p>
          )}
        </div>
      </Modal>
      {creating && (
        <CreateAgentDialog
          settings={settings}
          onClose={() => {
            setCreating(false)
          }}
        />
      )}
    </Card>
  )
}

// Paramètres > MCP: how to connect, who may connect, and what an agent can call (with which parameters). The tools
// are the code (`app/api/mcp.py`).
export function McpSection() {
  const settings = useMcpSettings()

  if (settings.isLoading) return <p className="settings-muted">Chargement…</p>
  if (settings.isError || !settings.data) {
    return <p className="settings-error">Les outils MCP n’ont pas pu être chargés.</p>
  }

  return (
    <div className="mcp">
      <p className="mcp-lead">
        Les agents se connectent au serveur MCP de VIPER (protocole <code>{settings.data.protocol_version}</code>), par
        OAuth ou avec un jeton d’accès. Aucun de ces outils n’écrit dans la base sans vous : une soumission devient une
        proposition que vous validez dans Missions.
      </p>
      <ConnectCard endpoint={settings.data.endpoint} />
      <AgentsCard settings={settings.data} />
      <McpCallsCard />
      <div className="mcp-tools">
        {settings.data.tools.map((tool) => (
          <ToolCard key={tool.name} tool={tool} />
        ))}
      </div>
    </div>
  )
}
