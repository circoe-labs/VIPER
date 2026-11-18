import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { type GraphFilters, type LinkGraph, otherSide, type PersonLink, useLinkGraph, useRelationLabels } from '../api/links'
import { foldText } from '../lib/text'
import { Switch } from '../ui/fields'
import { SelectField } from '../ui/fields'
import { EmptyState } from '../ui/EmptyState'
import { CloseIcon, UsersIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
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

// The strength of a link as a colour (from the grey border to the accent) and a thickness (1.5 to 10 px).
export function edgeStyle(score: number): { stroke: string; strokeWidth: number; opacity: number } {
  return {
    stroke: `color-mix(in srgb, var(--color-accent) ${String(score)}%, var(--color-border-strong))`,
    strokeWidth: 1.5 + (score / 100) * 8.5,
    opacity: 0.4 + (score / 100) * 0.6,
  }
}

// « Graphe de prospection »: a whiteboard of the connections. Prospects are grouped by company, members stand beside
// them, and a thread joins two people who know each other — the thicker and more coloured, the stronger the link.
export function GraphPage() {
  const [filters, setFilters] = useState<GraphFilters>({ min_score: 0, relation: null, company_id: null, include_unlinked: false })
  const graph = useLinkGraph(filters)
  const relations = useRelationLabels()
  const [search, setSearch] = useState('')
  const [company, setCompany] = useState('')
  const [showMembers, setShowMembers] = useState(true)
  const [showLabels, setShowLabels] = useState(false)
  // `?focus=prospect:<id>` (prospectGraphHref): opens with that person selected.
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(() => searchParams.get(GRAPH_FOCUS_PARAM))

  const data = graph.data ?? EMPTY
  const visible = useMemo<LinkGraph>(() => {
    const members = showMembers ? data.members : []
    const companies = data.companies.filter((item) => !company || (item.id ?? 'none') === company)
    const shown = new Set(companies.flatMap((item) => item.prospects.map(personKey)))
    for (const member of members) shown.add(personKey(member))
    const links = data.links.filter((link) => shown.has(personKey(link.a)) && shown.has(personKey(link.b)) && (showMembers || (link.a.kind !== 'member' && link.b.kind !== 'member')))
    return { members, companies, links }
  }, [data, company, showMembers])
  const layout = useMemo(() => layoutGraph(visible), [visible])
  const needle = foldText(search.trim())
  const matches = useMemo(() => {
    if (!needle) return null
    const keys = new Set<string>()
    for (const node of layout.nodes.values()) if (foldText(node.person.name).includes(needle)) keys.add(node.key)
    return keys
  }, [needle, layout])

  const empty = graph.isSuccess && data.links.length === 0 && data.companies.length === 0

  return (
    <div className="prospection graph-page">
      <PageHeader
        mascot="search"
        title="Graphe de prospection"
        description="Qui connaît qui : les prospects par société, les membres de CIRCOE, et la force de chaque lien."
        actions={
          <Link to="/prospection" className="btn btn--secondary btn--md">
            Retour à la base
          </Link>
        }
      />
      <section className="graph-filters" aria-label="Filtres du graphe">
        <SearchField label="Trouver une personne" value={search} onChange={setSearch} />
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

      {graph.isError && <p role="alert">Le graphe n’a pas pu être chargé.</p>}
      {graph.isPending && <p role="status">Chargement du graphe…</p>}
      {empty && (
        <EmptyState
          icon={UsersIcon}
          title="Aucun lien pour l’instant"
          description="Ouvrez la fiche d’un prospect et ajoutez ses relations (dans « Relations ») : elles apparaîtront ici, regroupées par société."
        />
      )}
      {graph.isSuccess && !empty && (
        <div className="graph-board">
          <Canvas
            layout={layout}
            links={visible.links}
            matches={matches}
            selected={selected}
            showLabels={showLabels}
            onSelect={setSelected}
          />
          <Legend />
          {selected && layout.nodes.get(selected) && (
            <Details
              nodeKey={selected}
              layout={layout}
              links={visible.links}
              onClose={() => {
                setSelected(null)
              }}
              onSelect={setSelected}
            />
          )}
        </div>
      )}
    </div>
  )
}

function Legend() {
  return (
    <div className="graph-legend" aria-hidden="true">
      <span>Lien faible</span>
      <svg width="120" height="14">
        <defs>
          <linearGradient id="graph-legend-gradient">
            <stop offset="0%" style={{ stopColor: 'var(--color-border-strong)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--color-accent)' }} />
          </linearGradient>
        </defs>
        <polygon points="0,6 120,0 120,14 0,8" fill="url(#graph-legend-gradient)" />
      </svg>
      <span>fort</span>
    </div>
  )
}

interface CanvasProps {
  layout: GraphLayout
  links: PersonLink[]
  matches: Set<string> | null
  selected: string | null
  showLabels: boolean
  onSelect: (key: string | null) => void
}

function Canvas({ layout, links, matches, selected, showLabels, onSelect }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  // The board refits whenever the layout changes (a filter moved): a view belongs to the layout it was made for.
  const [state, setState] = useState<{ layout: GraphLayout; view: View }>({ layout, view: layout.bounds })
  const view = state.layout === layout ? state.view : layout.bounds
  const setView = useCallback(
    (change: View | ((current: View) => View)) => {
      setState((previous) => {
        const current = previous.layout === layout ? previous.view : layout.bounds
        return { layout, view: typeof change === 'function' ? change(current) : change }
      })
    },
    [layout],
  )
  const [hover, setHover] = useState<string | null>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

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

  const focus = hover ?? selected
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

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const start = drag.current
    const matrix = svgRef.current?.getScreenCTM()
    if (!start || !matrix) return
    const dx = (event.clientX - start.x) / matrix.a
    const dy = (event.clientY - start.y) / matrix.d
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3) start.moved = true
    start.x = event.clientX
    start.y = event.clientY
    setView((current) => ({ ...current, x: current.x - dx, y: current.y - dy }))
  }
  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (drag.current && !drag.current.moved && event.target === event.currentTarget) onSelect(null)
    drag.current = null
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
        viewBox={`${String(view.x)} ${String(view.y)} ${String(view.width)} ${String(view.height)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {layout.blobs.map((blob) => (
          <g key={blob.key} className={`graph-blob graph-blob--${blob.kind}`}>
            <circle cx={blob.x} cy={blob.y} r={blob.radius} />
            {blob.kind === 'company' && (
              <text x={blob.x} y={blob.y - blob.radius - 10} textAnchor="middle">
                {blob.name}
              </text>
            )}
          </g>
        ))}
        <g className="graph-edges">
          {links.map((link) => {
            const from = layout.nodes.get(personKey(link.a))
            const to = layout.nodes.get(personKey(link.b))
            if (!from || !to) return null
            const active = !focus || (related.has(personKey(link.a)) && related.has(personKey(link.b)) && (personKey(link.a) === focus || personKey(link.b) === focus))
            const style = edgeStyle(link.score)
            return (
              <g key={link.id} className={active ? 'graph-edge' : 'graph-edge graph-edge--dim'}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} style={style} strokeLinecap="round">
                  <title>{`${link.a.name} — ${link.b.name} : ${link.relation} (${String(link.score)}/100)`}</title>
                </line>
                {(showLabels || (focus && active)) && (
                  <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} textAnchor="middle" className="graph-edge__label">
                    {`${link.relation} · ${String(link.score)}`}
                  </text>
                )}
              </g>
            )
          })}
        </g>
        <g className="graph-nodes">
          {[...layout.nodes.values()].map((node) => {
            const dim = (focus && !related.has(node.key)) || (matches && !matches.has(node.key))
            const member = node.person.kind === 'member'
            return (
              <g
                key={node.key}
                className={['graph-node', member ? 'graph-node--member' : '', selected === node.key ? 'is-selected' : '', dim ? 'is-dim' : '', matches?.has(node.key) ? 'is-match' : ''].filter(Boolean).join(' ')}
                transform={`translate(${String(node.x)} ${String(node.y)})`}
                tabIndex={0}
                role="button"
                aria-label={`${node.person.name}${node.person.company_name ? `, ${node.person.company_name}` : ''}`}
                onPointerDown={(event) => {
                  event.stopPropagation()
                }}
                onClick={() => {
                  onSelect(node.key)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelect(node.key)
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
      </svg>
      <div className="graph-canvas__controls">
        <IconButton label="Zoom avant" icon={ZoomIn} size="sm" variant="secondary" onClick={() => { zoom(1 / 1.25) }} />
        <IconButton label="Zoom arrière" icon={ZoomOut} size="sm" variant="secondary" onClick={() => { zoom(1.25) }} />
        <Button size="sm" onClick={() => { setView(layout.bounds) }}>
          Tout voir
        </Button>
      </div>
    </div>
  )
}

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
