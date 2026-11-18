// Deep link to the Prospection graph (`/prospection/graphe`, prospection/GraphPage.tsx) focused on one prospect: the
// page reads `?prospect=<id>` as its initial selection. Local equivalent of a shared `prospectGraphHref` helper: keep
// one of the two when branches merge.
export function prospectGraphHref(prospectId: string): string {
  return `/prospection/graphe?prospect=${encodeURIComponent(prospectId)}`
}
