import { ApiError } from '../api/client'
import type { MissionSource } from '../api/missions'
import { matchesWords } from '../lib/text'
import { buildSourceTree, type SourceNode, sourceName } from './sourceTree'

// What the sources card needs of a source: enough to list it, whichever list it comes from (mission, category, library).
export type SourceRef = Pick<MissionSource, 'id' | 'url' | 'label' | 'parent_id'>

export function toRef(source: SourceRef): SourceRef {
  return { id: source.id, url: source.url, label: source.label, parent_id: source.parent_id ?? null }
}

// The library minus what the mission already has, as a tree, narrowed by the search. A root stays (as a heading) when
// one of its sub-sources matches, so a found sub-source is always shown under its site.
export function addableTree(library: readonly MissionSource[], taken: ReadonlySet<string>, query: string): SourceNode[] {
  const wanted = query.trim()
  const matches = (source: MissionSource) =>
    wanted === '' || matchesWords(`${sourceName(source)} ${source.url} ${source.description ?? ''}`, wanted)
  const nodes: SourceNode[] = []
  for (const { source, children } of buildSourceTree(library)) {
    const kids = children.filter((child) => !taken.has(child.id) && (matches(child) || matches(source)))
    const rootOffered = !taken.has(source.id) && matches(source)
    if (rootOffered || kids.length > 0) nodes.push({ source, children: kids })
  }
  return nodes
}

// Same address, ignoring case, a trailing slash and a leading « www. », as the server files a link.
function addressKey(url: string): string {
  return url.trim().toLowerCase().replace(/^(https?:\/\/)www\./, '$1').replace(/\/+$/, '')
}

export function findByAddress<T extends { url: string }>(rows: readonly T[], url: string): T | undefined {
  const key = addressKey(url)
  return rows.find((row) => addressKey(row.url) === key)
}

// Why a typed address cannot be saved (the server refuses the same), or null.
export function addressProblem(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return 'Saisissez l’adresse du site.'
  try {
    const url = new URL(text)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') throw new Error('scheme')
  } catch {
    return 'Adresse invalide : saisissez un lien complet, par exemple https://www.exemple.fr/annuaire.'
  }
  return null
}

// The server's own sentence for a refusal (`detail.message`, already in French), else `fallback`: never the raw
// « failed with HTTP 4xx ». A dropped connection says so.
export function refusalMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return 'Le serveur est injoignable. Vérifiez votre connexion et réessayez.'
  const { detail } = error
  if (typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string') {
    return detail.message
  }
  return fallback
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}
