import type { MissionSource } from '../api/missions'

export interface SourceNode {
  source: MissionSource
  children: MissionSource[]
}

export function sourceName(source: Pick<MissionSource, 'label' | 'url'>): string {
  return source.label?.trim() || source.url
}

// The library is served flat (one level: a root and its sub-sources). A sub-source whose root is missing from the
// answer (a search matched only the child) is shown as its own entry so nothing found is hidden.
export function buildSourceTree(flat: readonly MissionSource[]): SourceNode[] {
  const ids = new Set(flat.map((source) => source.id))
  const byParent = new Map<string, MissionSource[]>()
  const roots: MissionSource[] = []
  for (const source of flat) {
    if (source.parent_id && ids.has(source.parent_id)) {
      byParent.set(source.parent_id, [...(byParent.get(source.parent_id) ?? []), source])
    } else {
      roots.push(source)
    }
  }
  return roots.map((source) => ({ source, children: byParent.get(source.id) ?? [] }))
}

// What the counter means: accepted items the source supported, never visits or missions attached.
export function usesLabel(count: number): string {
  if (count === 0) return 'Aucune utilisation réussie'
  return `${String(count)} utilisation${count > 1 ? 's' : ''} réussie${count > 1 ? 's' : ''}`
}

// A root's figure rolls its sub-sources up; a sub-source shows its own.
export function usesOf(source: MissionSource): number {
  return source.rolled_up_uses ?? source.successful_uses ?? 0
}
