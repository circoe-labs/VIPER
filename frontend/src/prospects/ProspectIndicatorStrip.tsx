import type { ReactNode } from 'react'

import { Button } from '../ui/Button'
import { AlertIcon, ShieldCheckIcon, SpinnerIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { ScoreRing } from '../ui/ScoreRing'
import { completenessTone } from './completenessView'
import type { CompletenessView, IndicatorState, ProximityView } from './indicators'
import { proximityLabel, proximityTone } from './proximityView'
import './indicator-strip.css'

interface IndicatorStripProps {
  // The « Score prospect » card (ProspectScoreCard, detail dialog included): the commercial fit only.
  score: ReactNode
  completeness: IndicatorState<CompletenessView>
  proximity: IndicatorState<ProximityView>
}

// Top of the Profil tab: three equal cells, always in the same order (Score prospect, État de la fiche, Score de
// proximité). Each explains itself in an info tip instead of a paragraph.
export function ProspectIndicatorStrip({ score, completeness, proximity }: IndicatorStripProps) {
  return (
    <section className="indicator-strip" aria-label="Indicateurs de la fiche">
      <div className="indicator-cell" data-indicator="score">
        <span className="indicator-cell__corner">
          <InfoTip label="Aide : Score prospect">
            Intérêt commercial du prospect pour Circoe, d’après ses critères et les signaux validés. Les relations n’y entrent pas.
          </InfoTip>
        </span>
        {score}
      </div>
      <IndicatorCell
        title="État de la fiche"
        tip="Indique si la fiche est assez renseignée pour être exploitée : un état, pas une note."
        state={completeness}
        unavailable="Pas encore évalué"
      >
        {(value) => <CompletenessBody value={value} />}
      </IndicatorCell>
      <IndicatorCell
        title="Score de proximité"
        tip="De 0 à 100 : proximité entre les membres de Circoe et ce prospect, d’après les relations enregistrées. Indépendant du score prospect."
        state={proximity}
        unavailable="Pas encore calculé"
      >
        {(value) => <ProximityBody value={value} />}
      </IndicatorCell>
    </section>
  )
}

interface CellProps<T> {
  title: string
  tip: string
  state: IndicatorState<T>
  unavailable: string
  children: (value: T) => ReactNode
}

function IndicatorCell<T>({ title, tip, state, unavailable, children }: CellProps<T>) {
  return (
    <section className="indicator-cell" aria-label={title} data-state={state.status}>
      <div className="prospect-editor__section-head">
        <h3 className="prospect-editor__section-title">{title}</h3>
        <InfoTip label={`Aide : ${title}`}>{tip}</InfoTip>
      </div>
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

function CompletenessBody({ value }: { value: CompletenessView }) {
  const todo = value.missing.length
  const tone = completenessTone(value.state)
  return (
    <div className="indicator-cell__body">
      <span className="indicator-cell__disc" data-tone={tone} aria-hidden="true">
        <ShieldCheckIcon size={30} />
      </span>
      <span className="indicator-cell__text">
        <span className="indicator-cell__state">
          <span className="indicator-cell__strong indicator-cell__label" data-tone={tone}>
            {value.label}
          </span>
          <InfoTip label={`Aide : fiche ${value.label.toLowerCase()}`} size={14}>
            {value.description}
          </InfoTip>
        </span>
        <span className="indicator-cell__muted">
          {todo === 0 ? 'Rien à compléter' : `${String(todo)} à compléter`}
          {todo > 0 && (
            <InfoTip label="Éléments à compléter" size={14}>
              {value.missing.join(' · ')}
            </InfoTip>
          )}
        </span>
      </span>
    </div>
  )
}

function ProximityBody({ value }: { value: ProximityView }) {
  if (value.state === 'empty') return <EmptyBody text="Aucune relation enregistrée : proximité inconnue." />
  if (value.state === 'unreachable') {
    return <EmptyBody text={`Aucun membre Circoe relié à ce prospect (au plus ${String(value.maxHops)} liens).`} />
  }
  return (
    <div className="indicator-cell__body">
      <ScoreRing value={value.total} tone={proximityTone(value.total)} />
      <span className="indicator-cell__text">
        <span className="indicator-cell__strong">
          {proximityLabel(value.total)}
          <span className="visually-hidden"> : proximité {value.total} sur 100</span>
        </span>
        <span className="indicator-cell__muted">
          {value.pathCount} chemin{value.pathCount > 1 ? 's' : ''}
        </span>
        {value.bestPath && (
          <span className="indicator-cell__muted" title={value.bestPath}>
            {value.bestPath}
          </span>
        )}
      </span>
    </div>
  )
}
