import { Link } from 'react-router'

import { type CohortFigure, percent, type VerificationFigures, type VerificationTab } from './verificationFigures'

// The top of the verification space, from Lucie's sketch: four boxes (À vérifier bleu, Vérifié vert, Incertitude
// orange, Ignoré rouge) with the share of the base, a ring of the four, then the reading of the selected box.

const RADIUS = 15.9155 // circumference 100: a slice's length is its percentage

interface Box {
  tab: VerificationTab
  label: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  value: (figures: VerificationFigures) => number
}

const BOXES: Box[] = [
  { tab: 'verified', label: 'Vérifié', tone: 'success', value: (f) => f.verified },
  { tab: 'todo', label: 'À vérifier', tone: 'info', value: (f) => f.todo },
  { tab: 'uncertain', label: 'Incertitude', tone: 'warning', value: (f) => f.uncertain },
  { tab: 'ignored', label: 'Ignoré', tone: 'danger', value: (f) => f.ignored },
]

const color = (tone: Box['tone']) => `var(--color-${tone}-fg)`

// One colour per cohort, fixed by its number (S45 is always the same colour, whatever the cohorts shown): twelve
// distinct hues, none of them the four status colours of the boxes above.
const COHORT_COLORS = [
  '#4f8ef7',
  '#2fbf9b',
  '#f2b544',
  '#f0706e',
  '#a98bf2',
  '#e57fc1',
  '#63c8e8',
  '#b5cc4a',
  '#f28f4b',
  '#8c9bb0',
  '#3fa34d',
  '#c9a27a',
]

export function cohortColor(code: string): string {
  const number = Number(code.slice(1))
  return COHORT_COLORS[(Number.isFinite(number) ? number : 0) % COHORT_COLORS.length] ?? COHORT_COLORS[0] ?? '#4f8ef7'
}

interface Slice {
  key: string
  label: string
  value: number
  stroke: string
}

function Ring({ slices, total, label }: { slices: Slice[]; total: number; label: string }) {
  const lengths = slices.map((slice) => (total > 0 ? (slice.value / total) * 100 : 0))
  return (
    <svg viewBox="0 0 42 42" className="verification-ring" role="img" aria-label={label}>
      <circle cx="21" cy="21" r={RADIUS} fill="none" stroke="var(--color-border)" strokeWidth="6" />
      {slices.map((slice, index) => {
        const length = lengths[index] ?? 0
        const offset = 25 - lengths.slice(0, index).reduce((sum, part) => sum + part, 0)
        return (
          <circle
            key={slice.key}
            cx="21"
            cy="21"
            r={RADIUS}
            fill="none"
            stroke={slice.stroke}
            strokeWidth="6"
            strokeDasharray={`${String(length)} ${String(100 - length)}`}
            strokeDashoffset={String(offset)}
          >
            <title>{`${slice.label} : ${String(slice.value)} (${percent(slice.value, total)})`}</title>
          </circle>
        )
      })}
    </svg>
  )
}

interface OverviewProps {
  figures: VerificationFigures
  tab: VerificationTab
  onTab: (tab: VerificationTab) => void
}

export function VerificationOverview({ figures, tab, onTab }: OverviewProps) {
  const slices = BOXES.map((box) => ({
    key: box.tab,
    label: box.label,
    value: box.value(figures),
    stroke: color(box.tone),
  }))
  return (
    <section className="verification-overview" aria-label="Où en est la vérification">
      <div className="verification-boxes" role="group" aria-label="Choisir une catégorie">
        {BOXES.map((box) => (
          <button
            key={box.tab}
            type="button"
            className={`verification-box verification-box--${box.tone}`}
            aria-pressed={tab === box.tab}
            onClick={() => {
              onTab(box.tab)
            }}
          >
            <span className="verification-box__label">{box.label}</span>
            <strong className="verification-box__value">{box.value(figures)}</strong>
            <span className="verification-box__share">{percent(box.value(figures), figures.total)}</span>
          </button>
        ))}
      </div>
      <div className="verification-total">
        <Ring slices={slices} total={figures.total} label="Répartition de la base par catégorie de vérification" />
        <div>
          <p className="verification-total__figure">
            <strong>{figures.total}</strong> prospects dans la base
          </p>
          <ul className="verification-legend">
            {slices.map((slice) => (
              <li key={slice.key}>
                <span className="verification-legend__swatch" style={{ background: slice.stroke }} aria-hidden="true" />
                {slice.label} <strong>{slice.value}</strong> · {percent(slice.value, figures.total)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

function CohortBars({ cohorts, verified }: { cohorts: CohortFigure[]; verified: number }) {
  const max = Math.max(1, ...cohorts.map((cohort) => cohort.count))
  return (
    <ul className="verification-bars" aria-label="Vérifiés par cohorte">
      {cohorts.map((cohort) => (
        <li key={cohort.code} title={`${cohort.code} : ${String(cohort.count)} (${percent(cohort.count, verified)})`}>
          <span className="verification-bars__count">{cohort.count}</span>
          <span
            className="verification-bars__bar"
            style={{ height: `${String(Math.max((cohort.count / max) * 100, 3))}%`, background: cohortColor(cohort.code) }}
            aria-hidden="true"
          />
          <span className="verification-bars__code">{cohort.code}</span>
        </li>
      ))}
    </ul>
  )
}

// « Vérifié » : how many are in which cohort (and so what is programmed, what is not).
export function VerifiedReading({ figures }: { figures: VerificationFigures }) {
  const planned = figures.cohorts.filter((cohort) => cohort.planned)
  const sent = figures.cohorts.filter((cohort) => !cohort.planned)
  const programmed = planned.reduce((sum, cohort) => sum + cohort.count, 0)
  const sentTotal = sent.reduce((sum, cohort) => sum + cohort.count, 0)
  const slices: Slice[] = planned.map((cohort) => ({
    key: cohort.code,
    label: cohort.code,
    value: cohort.count,
    stroke: cohortColor(cohort.code),
  }))
  return (
    <div className="verification-reading">
      <h3>Combien de vérifiés dans quelle cohorte ?</h3>
      {figures.verified === 0 ? (
        <p>Aucun prospect vérifié pour le moment.</p>
      ) : (
        <>
          <CohortBars cohorts={figures.cohorts} verified={figures.verified} />
          <ul className="verification-legend">
            {figures.cohorts.map((cohort) => (
              <li key={cohort.code}>
                <span
                  className="verification-legend__swatch"
                  style={{ background: cohortColor(cohort.code) }}
                  aria-hidden="true"
                />
                <strong>{cohort.code}</strong> · {cohort.planned ? 'programmée' : 'envoyée'}
                {cohort.startsOn ? ` (${cohort.startsOn})` : ''} — {cohort.count} · {percent(cohort.count, figures.verified)}
              </li>
            ))}
          </ul>
          <h3>Programmés</h3>
          <div className="verification-total">
            {programmed > 0 ? (
              <Ring slices={slices} total={programmed} label="Prospects vérifiés des cohortes programmées" />
            ) : null}
            <ul className="verification-legend">
              {planned.map((cohort, index) => (
                <li key={cohort.code}>
                  <span
                    className="verification-legend__swatch"
                    style={{ background: slices[index]?.stroke ?? '' }}
                    aria-hidden="true"
                  />
                  {cohort.code} : {cohort.count} ({percent(cohort.count, figures.verified)})
                </li>
              ))}
              {planned.length === 0 && <li>Aucune cohorte programmée.</li>}
            </ul>
          </div>
          <p>
            Déjà envoyés : <strong>{sentTotal}</strong> ({percent(sentTotal, figures.verified)}) · Non programmés (vérifiés
            sans cohorte) : <strong>{figures.withoutCohort}</strong> ({percent(figures.withoutCohort, figures.verified)})
          </p>
        </>
      )}
    </div>
  )
}

export function IgnoredReading({ figures }: { figures: VerificationFigures }) {
  return (
    <div className="verification-reading">
      <p>
        <strong>{figures.ignored}</strong> prospects ignorés sur {figures.total} ({percent(figures.ignored, figures.total)} de la
        base) : plus en poste, entreprise radiée, personne décédée…
      </p>
      <Link to="/prospection?review=ignored" className="btn btn--secondary btn--md">
        Voir les ignorés
      </Link>
    </div>
  )
}
