import type { LinkGraph, Person } from '../api/links'

// Layout of the Prospection graph: one blob per company (its prospects on a ring inside it) and one small blob per
// member, placed by a short force simulation — blobs repel until they no longer overlap, and are pulled together by
// the links between them. Pure and deterministic: the same data always gives the same picture.

export const NODE_RADIUS = 22
const MEMBER_BLOB_RADIUS = 34
const MIN_VIEW = { width: 720, height: 440 }
// Room kept between blobs: the company name is written above its blob.
const GAP = 70

export interface PlacedNode {
  key: string
  person: Person
  x: number
  y: number
}

export interface PlacedBlob {
  key: string
  // A company (`company`) or a member standing alone (`member`).
  kind: 'company' | 'member'
  name: string
  companyId: string | null
  x: number
  y: number
  radius: number
}

export interface GraphLayout {
  blobs: PlacedBlob[]
  nodes: Map<string, PlacedNode>
  bounds: { x: number; y: number; width: number; height: number }
}

export function personKey(person: { kind: string; id: string }): string {
  return `${person.kind}:${person.id}`
}

export function blobRadius(count: number): number {
  if (count <= 1) return NODE_RADIUS + 22
  return Math.max(64, (count * (NODE_RADIUS * 2 + 10)) / (2 * Math.PI) + NODE_RADIUS + 26)
}

interface Body {
  key: string
  x: number
  y: number
  radius: number
}

function simulate(bodies: Body[], edges: Map<string, number>): void {
  const index = new Map(bodies.map((body, position) => [body.key, position]))
  bodies.forEach((body, position) => {
    // A spiral start: deterministic, and never two bodies on the same spot.
    const angle = position * 2.399963
    const distance = 90 * Math.sqrt(position + 1)
    body.x = Math.cos(angle) * distance
    body.y = Math.sin(angle) * distance
  })
  for (let step = 0; step < 320; step += 1) {
    const cooling = 1 - step / 340
    for (const [pair, weight] of edges) {
      const [first, second] = pair.split('|')
      const a = bodies[index.get(first) ?? -1]
      const b = bodies[index.get(second) ?? -1]
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.hypot(dx, dy) || 1
      const target = a.radius + b.radius + GAP
      const pull = (distance - target) * 0.012 * Math.min(3, weight) * cooling
      a.x += (dx / distance) * pull
      a.y += (dy / distance) * pull
      b.x -= (dx / distance) * pull
      b.y -= (dy / distance) * pull
    }
    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i]
      if (!a) continue
      a.x -= a.x * 0.004
      a.y -= a.y * 0.004
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j]
        if (!b) continue
        const dx = b.x - a.x || 0.01
        const dy = b.y - a.y || 0.01
        const distance = Math.hypot(dx, dy)
        const minimum = a.radius + b.radius + GAP
        if (distance >= minimum) continue
        const push = ((minimum - distance) / 2) * 0.6
        a.x -= (dx / distance) * push
        a.y -= (dy / distance) * push
        b.x += (dx / distance) * push
        b.y += (dy / distance) * push
      }
    }
  }
}

export function layoutGraph(graph: LinkGraph): GraphLayout {
  const blobOf = new Map<string, string>()
  const members: Person[] = graph.members
  const bodies: Body[] = []
  const meta = new Map<string, Omit<PlacedBlob, 'x' | 'y' | 'radius'> & { people: Person[] }>()

  for (const company of graph.companies) {
    const key = `company:${company.id ?? 'none'}`
    bodies.push({ key, x: 0, y: 0, radius: blobRadius(company.prospects.length) })
    meta.set(key, { key, kind: 'company', name: company.name, companyId: company.id, people: company.prospects })
    for (const person of company.prospects) blobOf.set(personKey(person), key)
  }
  for (const member of members) {
    const key = `member:${member.id}`
    bodies.push({ key, x: 0, y: 0, radius: MEMBER_BLOB_RADIUS })
    meta.set(key, { key, kind: 'member', name: member.name, companyId: null, people: [member] })
    blobOf.set(personKey(member), key)
  }

  const edges = new Map<string, number>()
  for (const link of graph.links) {
    const first = blobOf.get(personKey(link.a))
    const second = blobOf.get(personKey(link.b))
    if (!first || !second || first === second) continue
    const pair = [first, second].sort().join('|')
    edges.set(pair, (edges.get(pair) ?? 0) + link.score / 100)
  }
  simulate(bodies, edges)

  const blobs: PlacedBlob[] = []
  const nodes = new Map<string, PlacedNode>()
  for (const body of bodies) {
    const info = meta.get(body.key)
    if (!info) continue
    blobs.push({ key: info.key, kind: info.kind, name: info.name, companyId: info.companyId, x: body.x, y: body.y, radius: body.radius })
    const count = info.people.length
    info.people.forEach((person, position) => {
      const ring = body.radius - NODE_RADIUS - 14
      const angle = (position / count) * 2 * Math.PI - Math.PI / 2
      const x = count === 1 ? body.x : body.x + Math.cos(angle) * ring
      const y = count === 1 ? body.y : body.y + Math.sin(angle) * ring
      nodes.set(personKey(person), { key: personKey(person), person, x, y })
    })
  }

  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  blobs.forEach((blob, position) => {
    const left = blob.x - blob.radius
    const right = blob.x + blob.radius
    const top = blob.y - blob.radius - 24
    const bottom = blob.y + blob.radius
    if (position === 0) {
      minX = left
      maxX = right
      minY = top
      maxY = bottom
    }
    minX = Math.min(minX, left)
    maxX = Math.max(maxX, right)
    minY = Math.min(minY, top)
    maxY = Math.max(maxY, bottom)
  })
  const margin = 60
  // A small graph is not blown up to fill the board: the view is never tighter than this, centred on the content.
  const width = Math.max(maxX - minX + 2 * margin, MIN_VIEW.width)
  const height = Math.max(maxY - minY + 2 * margin, MIN_VIEW.height)
  return {
    blobs,
    nodes,
    bounds: { x: (minX + maxX) / 2 - width / 2, y: (minY + maxY) / 2 - height / 2, width, height },
  }
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]?.[0], words[words.length - 1]?.[0]] : [words[0]?.[0], words[0]?.[1]]
  return letters.filter(Boolean).join('').toUpperCase()
}

// One of the twelve cohort hues, always the same for the same name.
export function hueIndex(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 12
}
