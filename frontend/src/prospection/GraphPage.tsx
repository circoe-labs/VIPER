import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import { type GraphFilters, type LinkGraph, otherSide, type PersonLink, useLinkGraph, useRelationLabels } from '../api/links'
import { useCompanyEditor } from '../companies/CompanyEditorProvider'
import { ProspectOverlay } from '../contact/ProspectOverlay'
import { foldText } from '../lib/text'
import { Switch } from '../ui/fields'
import { SelectField } from '../ui/fields'
import { EmptyState } from '../ui/EmptyState'
import { ArrowLeftIcon, CloseIcon, FilterIcon, UsersIcon } from '../ui/icons'
import { Menu, type MenuItem } from '../ui/Menu'
import { SearchField } from '../ui/SearchField'
import { Button, IconButton } from '../ui/Button'
import { type GraphLayout, hueIndex, initials, layoutGraph, NODE_RADIUS, personKey } from './graphLayout'
import { GRAPH_FOCUS_PARAM } from '../prospects/prospectGraphHref'
import './graph.css'

const EMPTY: LinkGraph = { members: [], companies: [], links: [] }

interface View {
  x: number
  y: number
  width: number
  height: number
}

interface Offset {
  x: number
  y: number
}

// The strength of a link as a colour (from the grey border to the accent) and a thickness (1.5 to 10 px).
export function edgeStyle(score: number): { stroke: string; strokeWidth: number; opacity: number } {
  return {
    stroke: `color-mix(in srgb, var(--color-accent) ${String(score)}%, var(--color-border-strong))`,
    strokeWidth: 1.5 + (score / 100) * 8.5,
    opacity: 0.4 + (score / 100) * 0.6,
  }
}

// Left click selects (shift / ctrl adds, drag on the background draws a selection box) and drags the selected
// entities; right click opens their options; the wheel zooms; the middle button (or Space held) pans.
//
// « Graphe de prospection »: a whiteboard of the connections. Prospects are grouped by company (a rectangle of the
// company's colour), members stand beside them, and a thread joins two people who know each other — the thicker and
// more coloured, the stronger the link.
export function GraphPage() {
  const [filters, setFilters] = useState<GraphFilters>({ min_score: 0, relation: null, company_id: null, include_unlinked: false })
  const graph = useLinkGraph(filters)
  const relations = useRelationLabels()
  const [search, setSearch] = useState('')
  const [company, setCompany] = useState('')
  const [showMembers, setShowMembers] = useState(true)
  const [showLabels, setShowLabels] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  // `?focus=prospect:<id>` (prospectGraphHref): opens with that person selected.
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => {
    const focus = searchParams.get(GRAPH_FOCUS_PARAM)
    return new Set(focus ? [focus] : [])
  })
  // « Isoler »: only these entities and their contacts stay on the board.
  const [isolated, setIsolated] = useState<string[] | null>(null)
  const [fiche, setFiche] = useState<string | null>(null)
  const navigate = useNavigate()
  const openCompany = useCompanyEditor()

  const data = graph.data ?? EMPTY
  const visible = useMemo<LinkGraph>(() => {
    let members = showMembers ? data.members : []
    let companies = data.companies.filter((item) => !company || (item.id ?? 'none') === company)
    const shown = new Set(companies.flatMap((item) => item.prospects.map(personKey)))
    for (const member of members) shown.add(personKey(member))
    let links = data.links.filter((link) => shown.has(personKey(link.a)) && shown.has(personKey(link.b)) && (showMembers || (link.a.kind !== 'member' && link.b.kind !== 'member')))
    if (isolated) {
      const roots = new Set<string>()
      for (const key of isolated) {
        const owner = companies.find((item) => `company:${item.id ?? 'none'}` === key)
        if (owner) for (const person of owner.prospects) roots.add(personKey(person))
        else roots.add(key)
      }
      const keep = new Set(roots)
      for (const link of links) {
        if (roots.has(personKey(link.a))) keep.add(personKey(link.b))
        if (roots.has(personKey(link.b))) keep.add(personKey(link.a))
      }
      members = members.filter((member) => keep.has(personKey(member)))
      companies = companies.map((item) => ({ ...item, prospects: item.prospects.filter((person) => keep.has(personKey(person))) })).filter((item) => item.prospects.length > 0)
      links = links.filter((link) => keep.has(personKey(link.a)) && keep.has(personKey(link.b)))
    }
    return { members, companies, links }
  }, [data, company, showMembers, isolated])
  const layout = useMemo(() => layoutGraph(visible), [visible])
  const needle = foldText(search.trim())
  const matches = useMemo(() => {
    if (!needle) return null
    const keys = new Set<string>()
    for (const node of layout.nodes.values()) if (foldText(node.person.name).includes(needle)) keys.add(node.key)
    return keys
  }, [needle, layout])

  const empty = graph.isSuccess && data.links.length === 0 && data.companies.length === 0
  const single = selected.size === 1 ? ([...selected][0] ?? null) : null

  return (
    <div className="graph-page">
      <h1 className="visually-hidden">Graphe de prospection</h1>
      <div className="graph-bar">
        <Link to="/prospection" className="btn btn--secondary btn--sm graph-bar__back">
          <ArrowLeftIcon size={16} />
          Retour à la base
        </Link>
        <div className="graph-bar__search">
          <SearchField label="Trouver une personne" value={search} onChange={setSearch} />
        </div>
        <IconButton
          icon={FilterIcon}
          label="Filtres du graphe"
          size="sm"
          variant="secondary"
          aria-expanded={filtersOpen}
          onClick={() => {
            setFiltersOpen((open) => !open)
          }}
        />
        {isolated && (
          <Button
            size="sm"
            icon={CloseIcon}
            onClick={() => {
              setIsolated(null)
            }}
          >
            Tout afficher
          </Button>
        )}
      </div>
      {filtersOpen && (
        <section className="graph-filters" aria-label="Filtres du graphe">
          <SelectField
            label="Société"
            value={company}
            onChange={(event) => {
              setCompany(event.target.value)
            }}
          >
            <option value="">Toutes les sociétés</option>
            {data.companies.map((item) => (
              <option key={item.id ?? 'none'} value={item.id ?? 'none'}>
                {item.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Nature du lien"
            value={filters.relation ?? ''}
            onChange={(event) => {
              setFilters({ ...filters, relation: event.target.value || null })
            }}
          >
            <option value="">Toutes</option>
            {(relations.data ?? []).map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </SelectField>
          <label className="graph-filters__score">
            <span>Force minimale : {filters.min_score}/100</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={filters.min_score}
              onChange={(event) => {
                setFilters({ ...filters, min_score: Number(event.target.value) })
              }}
            />
          </label>
          <div className="graph-filters__switches">
            <Switch
              label="Membres"
              checked={showMembers}
              onChange={(event) => {
                setShowMembers(event.target.checked)
              }}
            />
            <Switch
              label="Étiquettes des liens"
              checked={showLabels}
              onChange={(event) => {
                setShowLabels(event.target.checked)
              }}
            />
            <Switch
              label="Autres prospects des sociétés"
              checked={filters.include_unlinked}
              onChange={(event) => {
                setFilters({ ...filters, include_unlinked: event.target.checked })
              }}
            />
          </div>
        </section>
      )}

      {graph.isError && <p role="alert" className="graph-page__notice">Le graphe n’a pas pu être chargé.</p>}
      {graph.isPending && <p role="status" className="graph-page__notice">Chargement du graphe…</p>}
      {empty && (
        <div className="graph-page__notice">
          <EmptyState
            icon={UsersIcon}
            title="Aucun lien pour l’instant"
            description="Ouvrez la fiche d’un prospect et ajoutez ses relations (dans « Relations ») : elles apparaîtront ici, regroupées par société."
          />
        </div>
      )}
      {graph.isSuccess && !empty && (
        <div className="graph-board">
          <Canvas
            layout={layout}
            links={visible.links}
            matches={matches}
            selected={selected}
            showLabels={showLabels}
            isolated={isolated !== null}
            onSelect={setSelected}
            onIsolate={setIsolated}
            onOpenFiche={setFiche}
            onOpenProspect={(id) => {
              void navigate(`/prospection?prospect=${id}`)
            }}
            onOpenCompany={(id) => {
              openCompany(id)
            }}
          />
          <Legend />
          {single && layout.nodes.get(single) && (
            <Details
              nodeKey={single}
              layout={layout}
              links={visible.links}
              onClose={() => {
                setSelected(new Set())
              }}
              onSelect={(key) => {
                setSelected(new Set([key]))
              }}
            />
          )}
        </div>
      )}
      {fiche && (
        <ProspectOverlay
          prospectId={fiche}
          onClose={() => {
            setFiche(null)
          }}
        />
      )}
    </div>
  )
}

function Legend() {
  return (
    <div className="graph-legend" aria-hidden="true">
      <span>Lien faible</span>
      <svg width="90" height="14">
        <defs>
          <linearGradient id="graph-legend-gradient">
            <stop offset="0%" style={{ stopColor: 'var(--color-border-strong)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--color-accent)' }} />
          </linearGradient>
        </defs>
        <polygon points="0,6 90,0 90,14 0,8" fill="url(#graph-legend-gradient)" />
      </svg>
      <span>fort</span>
      <span className="graph-legend__hint">Clic : sélectionner · Glisser : déplacer · Clic droit : options · Molette : zoom · Molette cliquée ou Espace : naviguer</span>
    </div>
  )
}

interface CanvasProps {
  layout: GraphLayout
  links: PersonLink[]
  matches: Set<string> | null
  selected: ReadonlySet<string>
  showLabels: boolean
  isolated: boolean
  onSelect: (keys: ReadonlySet<string>) => void
  onIsolate: (keys: string[] | null) => void
  onOpenFiche: (prospectId: string) => void
  onOpenProspect: (prospectId: string) => void
  onOpenCompany: (companyId: string) => void
}

interface Marquee {
  x1: number
  y1: number
  x2: number
  y2: number
}

type Gesture =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'move'; x: number; y: number; moved: boolean; keys: string[] }
  | { kind: 'box'; x: number; y: number; base: ReadonlySet<string>; additive: boolean; moved: boolean }

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

function Canvas({ layout, links, matches, selected, showLabels, isolated, onSelect, onIsolate, onOpenFiche, onOpenProspect, onOpenCompany }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  // The board refits (and moved entities return) whenever the layout changes: both belong to the layout they were made for.
  const [state, setState] = useState<{ layout: GraphLayout; view: View; moved: ReadonlyMap<string, Offset> }>({ layout, view: layout.bounds, moved: new Map() })
  const fresh = state.layout === layout
  const view = fresh ? state.view : layout.bounds
  const moved = fresh ? state.moved : EMPTY_MOVED
  const setView = useCallback(
    (change: View | ((current: View) => View)) => {
      setState((previous) => {
        const ok = previous.layout === layout
        const current = ok ? previous.view : layout.bounds
        return { layout, view: typeof change === 'function' ? change(current) : change, moved: ok ? previous.moved : new Map() }
      })
    },
    [layout],
  )
  const moveBy = useCallback(
    (keys: string[], dx: number, dy: number) => {
      setState((previous) => {
        const ok = previous.layout === layout
        const next = new Map(ok ? previous.moved : [])
        for (const key of keys) {
          const old = next.get(key) ?? { x: 0, y: 0 }
          next.set(key, { x: old.x + dx, y: old.y + dy })
        }
        return { layout, view: ok ? previous.view : layout.bounds, moved: next }
      })
    },
    [layout],
  )
  const [hover, setHover] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [spacePan, setSpacePan] = useState(false)
  const gesture = useRef<Gesture | null>(null)

  // People of each company rectangle: moving the rectangle carries them along.
  const members = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const node of layout.nodes.values()) {
      if (node.person.kind !== 'prospect') continue
      const key = `company:${node.person.company_id ?? 'none'}`
      map.set(key, [...(map.get(key) ?? []), node.key])
    }
    return map
  }, [layout])
  const rectangles = useMemo(() => layout.blobs.filter((blob) => blob.kind === 'company'), [layout])
  const offset = (key: string): Offset => moved.get(key) ?? { x: 0, y: 0 }
  const at = (key: string, x: number, y: number): Offset => ({ x: x + offset(key).x, y: y + offset(key).y })

  // Zoom around the pointer. A native listener: React's wheel handlers are passive and cannot stop the page scrolling.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const matrix = svg.getScreenCTM()
      if (!matrix) return
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
      const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12
      setView((current) => ({
        x: point.x - (point.x - current.x) * factor,
        y: point.y - (point.y - current.y) * factor,
        width: current.width * factor,
        height: current.height * factor,
      }))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      svg.removeEventListener('wheel', onWheel)
    }
  }, [setView])

  // Space held = pan with the left button; Escape clears the selection.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onSelect(new Set())
      if (event.code === 'Space' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault()
        setSpacePan(true)
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpacePan(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [onSelect])

  const singleSelected = selected.size === 1 ? ([...selected][0] ?? null) : null
  const focus = hover ?? (singleSelected && layout.nodes.has(singleSelected) ? singleSelected : null)
  const related = useMemo(() => {
    const keys = new Set<string>()
    if (!focus) return keys
    keys.add(focus)
    for (const link of links) {
      if (personKey(link.a) === focus) keys.add(personKey(link.b))
      if (personKey(link.b) === focus) keys.add(personKey(link.a))
    }
    return keys
  }, [focus, links])

  function toBoard(clientX: number, clientY: number): Offset {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return { x: 0, y: 0 }
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }
  const keyOf = (target: EventTarget | null): string | null => (target instanceof Element ? (target.closest('[data-key]')?.getAttribute('data-key') ?? null) : null)

  // The entities that actually move: the selected people and rectangles, and the people of the selected rectangles.
  function movable(keys: Iterable<string>): string[] {
    const all = new Set<string>()
    for (const key of keys) {
      all.add(key)
      for (const member of members.get(key) ?? []) all.add(member)
    }
    return [...all]
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button === 2) return
    setMenu(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    const board = toBoard(event.clientX, event.clientY)
    if (event.button === 1 || spacePan) {
      event.preventDefault()
      gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY }
      return
    }
    const key = keyOf(event.target)
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (key) {
      let next = selected
      if (additive) {
        const copy = new Set(selected)
        if (copy.has(key)) copy.delete(key)
        else copy.add(key)
        next = copy
        onSelect(copy)
      } else if (!selected.has(key)) {
        next = new Set([key])
        onSelect(next)
      }
      gesture.current = { kind: 'move', x: board.x, y: board.y, moved: false, keys: movable(next.has(key) ? next : [key]) }
      return
    }
    gesture.current = { kind: 'box', x: board.x, y: board.y, base: additive ? selected : new Set(), additive, moved: false }
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const current = gesture.current
    if (!current) return
    if (current.kind === 'pan') {
      const matrix = svgRef.current?.getScreenCTM()
      if (!matrix) return
      const dx = (event.clientX - current.x) / matrix.a
      const dy = (event.clientY - current.y) / matrix.d
      current.x = event.clientX
      current.y = event.clientY
      setView((view_) => ({ ...view_, x: view_.x - dx, y: view_.y - dy }))
      return
    }
    const board = toBoard(event.clientX, event.clientY)
    if (current.kind === 'move') {
      const dx = board.x - current.x
      const dy = board.y - current.y
      if (!current.moved && Math.hypot(dx, dy) < 3) return
      current.moved = true
      current.x = board.x
      current.y = board.y
      moveBy(current.keys, dx, dy)
      return
    }
    if (Math.hypot(board.x - current.x, board.y - current.y) < 3 && !current.moved) return
    current.moved = true
    const box = { x1: current.x, y1: current.y, x2: board.x, y2: board.y }
    setMarquee(box)
    const left = Math.min(box.x1, box.x2)
    const right = Math.max(box.x1, box.x2)
    const top = Math.min(box.y1, box.y2)
    const bottom = Math.max(box.y1, box.y2)
    const inside = new Set(current.base)
    for (const node of layout.nodes.values()) {
      const place = at(node.key, node.x, node.y)
      if (place.x >= left && place.x <= right && place.y >= top && place.y <= bottom) inside.add(node.key)
    }
    for (const blob of rectangles) {
      const place = at(blob.key, blob.x, blob.y)
      if (place.x - blob.radius >= left && place.x + blob.radius <= right && place.y - blob.radius >= top && place.y + blob.radius <= bottom) inside.add(blob.key)
    }
    onSelect(inside)
  }

  function onPointerUp() {
    const current = gesture.current
    gesture.current = null
    setMarquee(null)
    if (current?.kind === 'box' && !current.moved && !current.additive) onSelect(new Set())
  }

  function onContextMenu(event: React.MouseEvent<SVGSVGElement>) {
    event.preventDefault()
    const key = keyOf(event.target)
    let targets: ReadonlySet<string> = selected
    if (key && !selected.has(key)) {
      targets = new Set([key])
      onSelect(targets)
    }
    const items: MenuItem[] = []
    const keys = [...targets]
    const onlyKey = keys.length === 1 ? (keys[0] ?? null) : null
    const node = onlyKey ? layout.nodes.get(onlyKey) : undefined
    const rectangle = onlyKey ? rectangles.find((blob) => blob.key === onlyKey) : undefined
    if (node?.person.kind === 'prospect') {
      const id = node.person.id
      items.push({ id: 'fiche', label: 'Voir la fiche', onSelect: () => { onOpenFiche(id) } })
      items.push({ id: 'prospect', label: 'Voir le prospect', onSelect: () => { onOpenProspect(id) } })
      items.push({ id: 'isolate', label: 'Isoler le prospect et ses contacts', onSelect: () => { onIsolate([node.key]) } })
    } else if (node) {
      items.push({ id: 'isolate', label: 'Isoler le membre et ses contacts', onSelect: () => { onIsolate([node.key]) } })
    } else if (rectangle) {
      const companyId = rectangle.companyId
      if (companyId) items.push({ id: 'fiche', label: 'Voir la fiche de la société', onSelect: () => { onOpenCompany(companyId) } })
      items.push({ id: 'isolate', label: 'Isoler la société et ses contacts', onSelect: () => { onIsolate([rectangle.key]) } })
    } else if (keys.length > 1) {
      items.push({ id: 'isolate', label: `Isoler la sélection (${String(keys.length)}) et leurs contacts`, onSelect: () => { onIsolate(keys) } })
    }
    if (isolated) items.push({ id: 'all', label: 'Tout afficher', onSelect: () => { onIsolate(null) } })
    items.push({ id: 'fit', label: 'Tout voir', onSelect: () => { setView(layout.bounds) } })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  function zoom(factor: number) {
    setView((current) => {
      const cx = current.x + current.width / 2
      const cy = current.y + current.height / 2
      return { x: cx - (current.width * factor) / 2, y: cy - (current.height * factor) / 2, width: current.width * factor, height: current.height * factor }
    })
  }

  return (
    <div className="graph-canvas">
      <svg
        ref={svgRef}
        role="img"
        aria-label="Graphe des relations entre prospects et membres"
        className={spacePan ? 'is-panning' : undefined}
        viewBox={`${String(view.x)} ${String(view.y)} ${String(view.width)} ${String(view.height)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
      >
        {rectangles.map((blob) => {
          const place = at(blob.key, blob.x, blob.y)
          const hue = `var(--cohort-${String(hueIndex(blob.name))})`
          return (
            <g
              key={blob.key}
              data-key={blob.key}
              className={selected.has(blob.key) ? 'graph-blob is-selected' : 'graph-blob'}
              style={{ '--company-hue': hue } as React.CSSProperties}
            >
              <rect x={place.x - blob.radius} y={place.y - blob.radius} width={blob.radius * 2} height={blob.radius * 2 + 16} rx={16} />
              <text x={place.x - blob.radius + 12} y={place.y - blob.radius - 8}>
                {blob.name}
              </text>
            </g>
          )
        })}
        <g className="graph-edges">
          {links.map((link) => {
            const from = layout.nodes.get(personKey(link.a))
            const to = layout.nodes.get(personKey(link.b))
            if (!from || !to) return null
            const a = at(from.key, from.x, from.y)
            const b = at(to.key, to.x, to.y)
            const active = !focus || (related.has(personKey(link.a)) && related.has(personKey(link.b)) && (personKey(link.a) === focus || personKey(link.b) === focus))
            const style = edgeStyle(link.score)
            return (
              <g key={link.id} className={active ? 'graph-edge' : 'graph-edge graph-edge--dim'}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={style} strokeLinecap="round">
                  <title>{`${link.a.name} — ${link.b.name} : ${link.relation} (${String(link.score)}/100)`}</title>
                </line>
                {(showLabels || (focus && active)) && (
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} textAnchor="middle" className="graph-edge__label">
                    {`${link.relation} · ${String(link.score)}`}
                  </text>
                )}
              </g>
            )
          })}
        </g>
        <g className="graph-nodes">
          {[...layout.nodes.values()].map((node) => {
            const place = at(node.key, node.x, node.y)
            const dim = (focus && !related.has(node.key)) || (matches && !matches.has(node.key))
            const member = node.person.kind === 'member'
            return (
              <g
                key={node.key}
                data-key={node.key}
                className={['graph-node', member ? 'graph-node--member' : '', selected.has(node.key) ? 'is-selected' : '', dim ? 'is-dim' : '', matches?.has(node.key) ? 'is-match' : ''].filter(Boolean).join(' ')}
                transform={`translate(${String(place.x)} ${String(place.y)})`}
                tabIndex={0}
                role="button"
                aria-label={`${node.person.name}${node.person.company_name ? `, ${node.person.company_name}` : ''}`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation()
                    onSelect(new Set([node.key]))
                  }
                }}
                onMouseEnter={() => {
                  setHover(node.key)
                }}
                onMouseLeave={() => {
                  setHover(null)
                }}
                onFocus={() => {
                  setHover(node.key)
                }}
                onBlur={() => {
                  setHover(null)
                }}
              >
                <circle r={NODE_RADIUS} style={{ fill: `var(--cohort-${String(hueIndex(node.person.name))})` }} />
                <text className="graph-node__initials" textAnchor="middle" dy="0.35em">
                  {initials(node.person.name)}
                </text>
                <text className="graph-node__name" textAnchor="middle" y={NODE_RADIUS + 14}>
                  {node.person.name}
                </text>
              </g>
            )
          })}
        </g>
        {marquee && (
          <rect
            className="graph-marquee"
            x={Math.min(marquee.x1, marquee.x2)}
            y={Math.min(marquee.y1, marquee.y2)}
            width={Math.abs(marquee.x2 - marquee.x1)}
            height={Math.abs(marquee.y2 - marquee.y1)}
          />
        )}
      </svg>
      <div className="graph-canvas__controls">
        {selected.size > 1 && <span className="graph-canvas__count">{selected.size} sélectionnés</span>}
        <IconButton label="Zoom avant" icon={ZoomIn} size="sm" variant="secondary" onClick={() => { zoom(1 / 1.25) }} />
        <IconButton label="Zoom arrière" icon={ZoomOut} size="sm" variant="secondary" onClick={() => { zoom(1.25) }} />
        <Button size="sm" onClick={() => { setView(layout.bounds) }}>
          Tout voir
        </Button>
      </div>
      {menu && (
        <Menu
          label="Options du graphe"
          position={{ x: menu.x, y: menu.y }}
          sections={[{ items: menu.items }]}
          onClose={() => {
            setMenu(null)
          }}
        />
      )}
    </div>
  )
}

const EMPTY_MOVED: ReadonlyMap<string, Offset> = new Map()

const ZoomIn = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const ZoomOut = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
)

interface DetailsProps {
  nodeKey: string
  layout: GraphLayout
  links: PersonLink[]
  onClose: () => void
  onSelect: (key: string) => void
}

function Details({ nodeKey, layout, links, onClose, onSelect }: DetailsProps) {
  const person = layout.nodes.get(nodeKey)?.person
  if (!person) return null
  const own = { kind: person.kind, id: person.id }
  const mine = links.filter((link) => personKey(link.a) === nodeKey || personKey(link.b) === nodeKey).sort((a, b) => b.score - a.score)
  return (
    <aside className="graph-details" aria-label={`Relations de ${person.name}`}>
      <header>
        <div>
          <h2>{person.name}</h2>
          <p>{person.kind === 'member' ? 'Membre de l’organisation' : (person.company_name ?? 'Sans société')}</p>
        </div>
        <IconButton label="Fermer" icon={CloseIcon} size="sm" onClick={onClose} />
      </header>
      {person.kind === 'prospect' && (
        <Link to={`/prospection?prospect=${person.id}`} className="btn btn--secondary btn--sm">
          Ouvrir la fiche
        </Link>
      )}
      <ul>
        {mine.map((link) => {
          const other = otherSide(link, own)
          return (
            <li key={link.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(personKey(other))
                }}
              >
                <span>{other.name}</span>
                <span className="graph-details__relation">{link.relation}</span>
                <span className="graph-details__score">{link.score}/100</span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
