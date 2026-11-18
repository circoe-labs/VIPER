import { personKey } from '../prospection/graphLayout'

// Where the Prospection relations graph (`/prospection/graphe`, GraphPage.tsx) opens focused on one prospect: the
// `focus` query parameter is a graph node key (`prospect:<id>`); GraphPage selects that node on load (highlights it and
// its relations, opens its details). One helper shared by the prospect sheet's « Graph » button and the context menu.
export const GRAPH_PATH = '/prospection/graphe'
export const GRAPH_FOCUS_PARAM = 'focus'

export function prospectGraphHref(prospectId: string): string {
  const params = new URLSearchParams({
    [GRAPH_FOCUS_PARAM]: personKey({ kind: 'prospect', id: prospectId }),
  })
  return `${GRAPH_PATH}?${params.toString()}`
}
