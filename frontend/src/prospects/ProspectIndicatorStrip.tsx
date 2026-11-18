import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, type IconComponent, InfoIcon, ShieldCheckIcon, SparklesIcon, SpinnerIcon, UsersIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { ScoreRing } from '../ui/ScoreRing'
import { completenessTone } from './completenessView'
import type { CompletenessView, IndicatorState, ProximityView } from './indicators'
import { prospectGraphHref } from './prospectGraphHref'
import { proximityLabel, proximityTone } from './proximityView'
import './indicator-strip.css'

interface IndicatorStripProps {
  // The « Score prospect » card (ProspectScoreCard, detail dialog included): the commercial fit only. It fills the
  // fixed-height card it is given (its own title, ring and actions are its business).
  score: ReactNode
  completeness: IndicatorState<CompletenessView>
  proximity: IndicatorState<ProximityView>
}

// Top of the Profil tab: exactly three cards of the same height, always in the same order (Score prospect, Score de
// proximité, État de la fiche). The height never depends on the state: loading, empty and error replace the card's
// content in place. Each explains itself in an info tip instead of a paragraph.
export function ProspectIndicatorStrip({ score, completeness, proximity }: IndicatorStripProps) {
  return (
    <section className="indicator-strip" aria-label="Indicateurs de la fiche">
      <div className="indicator-cell" data-indicator="score">
        {score}
      </div>
      <IndicatorCell
        title="Score de proximité"
        tip="De 0 à 100 : proximité entre les membres de Circoe et ce prospect, d’après les relations enregistrées. Indépendant du score prospect."
        state={proximity}
        unavailable="Pas encore calculé"
        kind="proximity"
      >
        {(value) => <ProximityBody value={value} />}
      </IndicatorCell>
      <IndicatorCell
        title="État de la fiche"
        tip={(value) => (
          <>
            {value.description}
            {value.missing.length > 0 && (
              <>
                <br />
                <strong>À compléter :</strong> {value.missing.join(' · ')}
              </>
            )}
          </>
        )}
        fallbackTip="Indique si la fiche est assez renseignée pour être exploitée : un état, pas une note."
        state={completeness}
        unavailable="Pas encore évalué"
        kind="fiche"
      >
        {(value) => <CompletenessBody value={value} />}
      </IndicatorCell>
    </section>
  )
}

interface CellProps<T> {
  title: string
  tip?: ReactNode | ((value: T) => ReactNode)
  fallbackTip?: string
  state: IndicatorState<T>
  unavailable: string
  kind: 'proximity' | 'fiche'
  children: (value: T) => ReactNode
}

function IndicatorCell<T>({ title, tip, fallbackTip, state, unavailable, kind, children }: CellProps<T>) {
  const tipContent = typeof tip === 'function' ? (state.status === 'ready' ? tip(state.value) : fallbackTip) : (tip ?? fallbackTip)
  return (
    <section className="indicator-cell" aria-label={title} data-state={state.status} data-indicator={kind}>
      <div className="indicator-cell__head">
        <h3 className="indicator-cell__title">{title}</h3>
        <InfoTip label={`Aide : ${title}`}>{tipContent}</InfoTip>
      </div>
      <div className="indicator-cell__content">
        {state.status === 'ready' && children(state.value)}
        {state.status === 'loading' && (
          <p className="indicator-cell__empty" role="status">
            <SpinnerIcon size={16} />
            Chargement…
          </p>
        )}
        {state.status === 'unavailable' && <EmptyBody text={state.reason ?? unavailable} />}
        {state.status === 'error' && (
          <div className="indicator-cell__empty indicator-cell__empty--error" role="alert">
            <AlertIcon size={16} />
            <span>{state.message}</span>
            {state.onRetry && (
              <Button size="sm" onClick={state.onRetry}>
                Réessayer
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// No figure to show (not evaluated, no relation): a muted disc with the reason in words.
function EmptyBody({ text }: { text: string }) {
  return (
    <div className="indicator-cell__body">
      <span className="indicator-cell__disc" aria-hidden="true">
        –
      </span>
      <span className="indicator-cell__text">
        <span className="indicator-cell__muted indicator-cell__muted--wrap">{text}</span>
      </span>
    </div>
  )
}

// One distinct icon per state (the shape carries the meaning as much as the tone): to complete, usable, provided, very
// provided. A state the frontend does not know (newer backend) gets the neutral info icon.
const STATE_ICONS: Record<string, IconComponent> = {
  incomplete: AlertIcon,
  usable: CheckCircleIcon,
  rich: ShieldCheckIcon,
  very_rich: SparklesIcon,
}

// The fiche state: the state word big, a small sober icon tile in the state's tone, and one sentence built from the
// backend's real criteria. The « à compléter » list stays in the tooltip.
function CompletenessBody({ value }: { value: CompletenessView }) {
  const tone = completenessTone(value.state)
  const Icon = STATE_ICONS[value.state] ?? InfoIcon
  return (
    <div className="fiche-state" data-tone={tone} data-state={value.state}>
      <span className="fiche-state__icon" aria-hidden="true">
        <Icon size={24} />
      </span>
      <span className="indicator-cell__text">
        <span className="fiche-state__label">{value.label}</span>
        {value.sentence && (
          <span className="fiche-state__sentence" title={value.sentence}>
            {value.sentence}
          </span>
        )}
      </span>
    </div>
  )
}

// « Voir le graphe »: opens the relations graph on this prospect (a router link, no reload). Absent when the score
// does not say whose prospect it is.
function GraphButton({ prospectId }: { prospectId: string | undefined }) {
  if (!prospectId) return null
  return (
    <Link to={prospectGraphHref(prospectId)} className="btn btn--secondary btn--sm indicator-cell__graph">
      <UsersIcon size={16} />
      Voir le graphe
    </Link>
  )
}

function ProximityBody({ value }: { value: ProximityView }) {
  // No relation at all: nothing to look at in the graph, so no button.
  if (value.state === 'empty') return <EmptyBody text="Aucune relation enregistrée : proximité inconnue." />
  if (value.state === 'unreachable') {
    return (
      <div className="indicator-cell__body">
        <span className="indicator-cell__disc" aria-hidden="true">
          –
        </span>
        <span className="indicator-cell__text">
          <span className="indicator-cell__muted indicator-cell__muted--wrap">
            Aucun membre Circoe relié à ce prospect (au plus {value.maxHops} liens).
          </span>
          <GraphButton prospectId={value.prospectId} />
        </span>
      </div>
    )
  }
  const tone = proximityTone(value.total)
  return (
    <div className="indicator-cell__body">
      <ScoreRing value={value.total} tone={tone} />
      <span className="indicator-cell__text">
        <span className="indicator-cell__strong" data-tone={tone}>
          {proximityLabel(value.total)}
          <span className="visually-hidden"> : proximité {value.total} sur 100</span>
        </span>
        <span className="indicator-cell__muted">
          {value.pathCount} chemin{value.pathCount > 1 ? 's' : ''}
        </span>
        {value.bestPathEnds && (
          <span className="indicator-cell__muted indicator-cell__muted--path" title={value.bestPath ?? value.bestPathEnds}>
            {value.bestPathEnds}
          </span>
        )}
        <GraphButton prospectId={value.prospectId} />
      </span>
    </div>
  )
}
