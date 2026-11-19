import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router'

import { useIntegrations } from '../api/integrations'
import { useToolboxStatus } from '../api/toolbox'
import { formatDateTime } from '../contact/labels'
import { Button } from '../ui/Button'
import { AlertIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { useCalendlyConnection } from './connections/calendly'
import { type Connection, OPEN_PARAM } from './connections/connection'
import { ConnectionDialog } from './connections/ConnectionDialog'
import { ConnectionTile } from './connections/ConnectionTile'
import { useHumanizerConnection } from './connections/humanizer'
import { useOpenAIConnection } from './connections/openai'
import { useToolboxConnection, useToolboxFlow } from './connections/toolbox'
import './connections/connections.css'

// The names of the settings, as the page shows them (for the « dropped at startup » warning).
const SETTING_LABELS: Record<string, string> = {
  openai_api_key: 'clé d’API OpenAI',
  openai_model: 'modèle',
  openai_base_url: 'adresse de l’API',
  openai_timeout_ms: 'délai d’attente',
  openai_max_retries: 'nouvelles tentatives',
  contact_booking_url: 'lien de prise de rendez-vous',
  contact_initial_prompt: 'prompt initial',
  mission_creator_prompt: 'prompt de l’assistant de création de mission',
  taxonomy_cleanup_prompt: 'prompt de nettoyage des listes',
  prospect_scoring_prompt: 'prompt du score prospect',
  circoe_target: 'cible Circoe',
  default_outbound_email: 'adresse « De » par défaut',
  toolbox_mail_enabled: 'activation de la Toolbox',
  toolbox_mcp_url: 'adresse du serveur CIRCOE Toolbox',
  toolbox_oauth_redirect_uri: 'adresse de retour',
  contact_dispatch_enabled: 'envoi automatique des mails programmés',
  contact_dispatch_interval_ms: 'délai maximal avant envoi',
  infomaniak_send_allowlist: 'adresses autorisées',
  humanizer_enabled: 'contrôle du score humain',
  humanizer_min_score: 'score humain minimal',
}

// Config AI › Connexions: ONE tile per external service (identical size, the essentials only), the edit dialog of the
// clicked one opened on top (`?open=<id>`). Adding a connection = adding a descriptor below, not a page. The page is
// also where the Toolbox sends the browser back (`/settings/connections` redirects here, query kept).
export function ConnectionsSection() {
  const integrations = useIntegrations()
  const status = useToolboxStatus()
  const [params, setParams] = useSearchParams()
  const flow = useToolboxFlow()
  const data = integrations.data

  if (integrations.isPending || status.isPending) {
    return (
      <>
        <PanelHeader />
        <p className="settings-state">Chargement…</p>
      </>
    )
  }
  if (!data) {
    return (
      <>
        <PanelHeader />
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          Réglages des connexions indisponibles.
          <Button
            size="sm"
            onClick={() => {
              void status.refetch()
              void integrations.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      </>
    )
  }
  return <Connections data={data} status={status.data} flow={flow} open={params.get(OPEN_PARAM)} setOpen={(id) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (id) next.set(OPEN_PARAM, id)
        else next.delete(OPEN_PARAM)
        return next
      },
      { replace: true },
    )
  }} />
}

function PanelHeader({ info }: { info?: ReactNode }) {
  return (
    <header className="settings-panel__header">
      <h2 className="settings-panel__title">
        Connexions
        {info && <InfoTip label="Aide : Connexions">{info}</InfoTip>}
      </h2>
    </header>
  )
}

interface ConnectionsProps {
  data: NonNullable<ReturnType<typeof useIntegrations>['data']>
  status: ReturnType<typeof useToolboxStatus>['data']
  flow: ReturnType<typeof useToolboxFlow>
  open: string | null
  setOpen: (id: string | null) => void
}

function Connections({ data, status, flow, open, setOpen }: ConnectionsProps) {
  // The registry: the order of the tiles.
  const connections: Connection[] = [
    useOpenAIConnection(data),
    useToolboxConnection(data, status, flow),
    useCalendlyConnection(data),
    useHumanizerConnection(data),
  ]
  const opened = connections.find((connection) => connection.id === open)
  return (
    <>
      <PanelHeader
        info={
          <>
            Services externes utilisés par VIPER, réglés ici et appliqués aussitôt. Clés et accès sont conservés sur le
            serveur, hors de la base de données, et ne sont jamais renvoyés au navigateur. Toute personne connectée à VIPER
            peut les remplacer. Réglages dans {data.storage_path}
            {data.updated_at ? `, modifiés le ${formatDateTime(data.updated_at)}${data.updated_by ? ` par ${data.updated_by}` : ''}` : ''}.
          </>
        }
      />
      {data.load_error && (
        <p className="settings-connection__error" role="alert">
          <AlertIcon size={16} />
          Les réglages enregistrés ici n’ont pas pu être relus au démarrage du serveur (
          {data.load_error === 'unreadable' ? 'fichier illisible' : 'contenu refusé'}) : les valeurs par défaut s’appliquent
          {data.load_dropped.length > 0 ? ` pour : ${data.load_dropped.map((name) => SETTING_LABELS[name] ?? name).join(', ')}` : ''}.
          Enregistrez-les à nouveau.
        </p>
      )}
      <div className="conn-grid">
        {connections.map((connection) => (
          <ConnectionTile
            key={connection.id}
            connection={connection}
            onOpen={() => {
              setOpen(connection.id)
            }}
          />
        ))}
      </div>
      {opened && (
        <ConnectionDialog
          key={opened.id}
          connection={opened}
          onClose={() => {
            setOpen(null)
          }}
        />
      )}
    </>
  )
}
