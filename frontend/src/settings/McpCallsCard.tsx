import { Fragment, useState } from 'react'

import { type McpCall, useMcpCalls } from '../api/mcpSettings'
import { formatDateTime } from '../contact/labels'
import { StatusBadge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { ChevronDownIcon, ChevronRightIcon } from '../ui/icons'
import { Table } from '../ui/Table'

const OUTCOMES: Record<McpCall['outcome'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  ok: { label: 'OK', tone: 'success' },
  refused: { label: 'Refusé', tone: 'warning' },
  error: { label: 'Erreur', tone: 'danger' },
}

// The arguments in one line: `company_id: 01a…, search: entrepôt`.
function argumentsSummary(value: unknown): string {
  if (value === null || typeof value !== 'object') return ''
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
    .join(', ')
}

// « Historique des appels »: every tool an agent called on /mcp, under the e-mail of the person it acts for.
export function McpCallsCard() {
  const [email, setEmail] = useState('')
  const [tool, setTool] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const history = useMcpCalls({ email, tool })
  const pages = history.data?.pages ?? []
  const calls = pages.flatMap((page) => page.calls)
  const first = pages[0]

  return (
    <Card title="Historique des appels">
      <div className="mcp-calls__filters">
        <label className="mcp-calls__filter">
          <span>Personne</span>
          <select
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
          >
            <option value="">Toutes</option>
            {(first?.emails ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="mcp-calls__filter">
          <span>Outil</span>
          <select
            value={tool}
            onChange={(event) => {
              setTool(event.target.value)
            }}
          >
            <option value="">Tous</option>
            {(first?.tools ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {history.isLoading && <p className="settings-muted">Chargement…</p>}
      {history.isError && <p className="settings-error">L’historique n’a pas pu être chargé.</p>}
      {history.isSuccess && calls.length === 0 && <p className="settings-muted">Aucun appel pour l’instant.</p>}
      {calls.length > 0 && (
        <Table caption="Historique des appels MCP" density="compact">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Détail</span>
              </th>
              <th scope="col">Date</th>
              <th scope="col">Personne</th>
              <th scope="col">Agent</th>
              <th scope="col">Outil</th>
              <th scope="col">Paramètres</th>
              <th scope="col">Résultat</th>
              <th scope="col">Durée</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => {
              const outcome = OUTCOMES[call.outcome]
              const expanded = open === call.id
              return (
                <Fragment key={call.id}>
                  <tr>
                    <td>
                      <IconButton
                        icon={expanded ? ChevronDownIcon : ChevronRightIcon}
                        size="sm"
                        label={expanded ? 'Masquer le détail' : 'Voir le détail'}
                        aria-expanded={expanded}
                        onClick={() => {
                          setOpen(expanded ? null : call.id)
                        }}
                      />
                    </td>
                    <td className="mcp-calls__nowrap">{formatDateTime(call.created_at)}</td>
                    <td>{call.user_email ?? <span className="settings-muted">sans e-mail</span>}</td>
                    <td>{call.agent}</td>
                    <td>
                      <code>{call.tool}</code>
                    </td>
                    <td className="mcp-calls__args" title={argumentsSummary(call.arguments)}>
                      {argumentsSummary(call.arguments)}
                    </td>
                    <td title={call.error_message ?? undefined}>
                      <StatusBadge tone={outcome.tone}>
                        {outcome.label}
                        {call.error_code ? ` · ${call.error_code}` : ''}
                      </StatusBadge>
                    </td>
                    <td className="mcp-calls__nowrap">{call.duration_ms} ms</td>
                  </tr>
                  {expanded && (
                    <tr className="mcp-calls__detail">
                      <td colSpan={8}>
                        {call.error_message && <p className="settings-error">{call.error_message}</p>}
                        <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      )}
      {history.hasNextPage && (
        <Button
          size="sm"
          loading={history.isFetchingNextPage}
          onClick={() => {
            void history.fetchNextPage()
          }}
        >
          Voir plus
        </Button>
      )}
    </Card>
  )
}
