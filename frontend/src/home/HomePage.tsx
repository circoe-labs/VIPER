import { Link } from 'react-router'

import { type CommercialStage, COMMERCIAL_STAGES, type HomeData, useHome } from '../api/home'
import type { Segment } from '../api/prospection'
import { prospectionHref } from '../prospection/criteria'
import { SEGMENT_INFO, TRACKING_LABELS } from '../prospection/labels'
import { useProspectEditor } from '../prospection/prospectEditor'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
  BuildingIcon,
  CheckCircleIcon,
  ClockIcon,
  type IconComponent,
  InfoIcon,
  MinusCircleIcon,
  PlusIcon,
  SpinnerIcon,
  SpreadsheetIcon,
  UploadIcon,
  UsersIcon,
} from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { MonthlyProgress } from './MonthlyProgress'
import { NextActions } from './NextActions'
import { RecentActivity } from './RecentActivity'
import './home.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
// The API's business day (Europe/Paris) is a calendar date: formatted as such, whatever the browser's zone.
const TODAY = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

interface Kpi {
  label: string
  hint: string
  icon: IconComponent
  count: number
  href: string
  // A non-zero count asks for work (verification, due contacts): its glyph takes the warning colour.
  attention?: boolean
}

const ATTENTION: readonly Segment[] = [
  'never_verified',
  'needs_recheck',
  'email_missing',
  'email_invalid',
  'email_unverified',
  'due',
]

// Every prospect count is a Prospection segment: the card opens Prospection on it, where the counter shows the same
// number (same API semantics).
function segmentKpi(data: HomeData, segment: Segment, label = SEGMENT_INFO[segment].label): Kpi {
  const { hint, icon } = SEGMENT_INFO[segment]
  return {
    label,
    hint,
    icon,
    count: data.counts[segment],
    href: prospectionHref({ segment }),
    attention: ATTENTION.includes(segment),
  }
}

const STAGE_ICONS: Record<CommercialStage, IconComponent> = {
  quote_sent: SpreadsheetIcon,
  quote_follow_up: ClockIcon,
  won: CheckCircleIcon,
  not_interested: MinusCircleIcon,
}

function stageKpi(data: HomeData, stage: CommercialStage): Kpi {
  return {
    label: TRACKING_LABELS[stage],
    hint: `Étape actuelle du suivi de contact : ${TRACKING_LABELS[stage]}.`,
    icon: STAGE_ICONS[stage],
    count: data.stages[stage],
    href: prospectionHref({ tracking_status: stage }),
  }
}

function KpiCard({ label, hint, icon: Icon, count, href, attention = false }: Kpi) {
  return (
    <li>
      <Link to={href} className={`kpi-card${attention && count > 0 ? ' kpi-card--attention' : ''}`} title={hint}>
        <span className="kpi-card__label">
          <Icon size={14} />
          {label}
        </span>
        <span className="kpi-card__count">{NUMBER.format(count)}</span>
      </Link>
    </li>
  )
}

function KpiGroup({ id, title, kpis }: { id: string; title: string; kpis: Kpi[] }) {
  return (
    <div className="kpi-group">
      <h3 id={id} className="kpi-group__title eyebrow">
        {title}
      </h3>
      <ul className="kpi-group__cards" aria-labelledby={id}>
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </ul>
    </div>
  )
}

function Overview({ data }: { data: HomeData }) {
  const stale = data.stale_threshold_days
  const base: Kpi[] = [
    segmentKpi(data, 'all', 'Prospects'),
    {
      label: 'Entreprises',
      hint: 'Entreprises de la base, avec ou sans prospect.',
      icon: BuildingIcon,
      count: data.companies,
      href: '/prospection/companies',
    },
    ...(['active', 'unknown', 'inactive', 'do_not_contact'] as const).map((segment) => segmentKpi(data, segment)),
  ]
  const verification = (
    ['never_verified', 'needs_recheck', 'email_missing', 'email_invalid', 'email_unverified'] as const
  ).map((segment) => segmentKpi(data, segment))
  const contact = (['to_contact', 'due', 'contacted', 'no_response', 'responses', 'appointments'] as const).map(
    (segment) => segmentKpi(data, segment),
  )
  return (
    <>
      <section className="home-section" aria-labelledby="home-base-title">
        <h2 id="home-base-title" className="home-section__title">
          État de la base
        </h2>
        <KpiGroup id="home-kpi-base" title="Base" kpis={base} />
        <KpiGroup id="home-kpi-verification" title="Vérification" kpis={verification} />
        <p className="home-section__note">
          {stale === null
            ? 'Aucun seuil d’ancienneté configuré : « À revérifier » compte les coordonnées remises à vérifier après un changement d’entreprise.'
            : `« À revérifier » compte aussi les vérifications de plus de ${String(stale)} jours.`}
        </p>
      </section>

      <section className="home-section" aria-labelledby="home-contact-title">
        <h2 id="home-contact-title" className="home-section__title">
          Activité de contact
        </h2>
        <KpiGroup id="home-kpi-contact" title="Suivi de contact" kpis={contact} />
        <KpiGroup
          id="home-kpi-commercial"
          title="Suivi commercial léger"
          kpis={COMMERCIAL_STAGES.map((stage) => stageKpi(data, stage))}
        />
        <p className="home-section__note">
          Devis, suivi du devis, gagné et pas intéressé : étape actuelle saisie dans le suivi de contact de chaque
          prospect.
        </p>
      </section>

      <NextActions actions={data.next_actions} />
    </>
  )
}

function EmptyBase() {
  const { canCreate } = useProspectEditor()
  return (
    <EmptyState
      icon={UsersIcon}
      title="La base est vide"
      description="Importez le fichier Excel de prospection pour alimenter la base : chaque ligne est relue avant d’être enregistrée. L’accueil montrera ensuite l’état de la base, l’activité de contact et les prochaines actions."
      action={
        <div className="home-empty__actions">
          <Link to="/prospection/import" className="btn btn--primary btn--md">
            <UploadIcon size={18} />
            Importer Excel
          </Link>
          {canCreate && (
            <Link to={prospectionHref({ prospect: 'new' })} className="btn btn--secondary btn--md">
              <PlusIcon size={18} />
              Ajouter un prospect
            </Link>
          )}
        </div>
      }
    />
  )
}

// Accueil (Task 16): global visibility first — the base and the contact activity, every prospect count a link to its
// Prospection segment — then what to do next, and beside each other the month's progress (informative) and the latest
// imports and edits. Real data only.
export function HomePage() {
  const home = useHome()
  const data = home.data
  return (
    <div className="home">
      <PageHeader
        title="Accueil"
        description={
          data
            ? `Où en sont la base et l’activité de contact, puis quoi faire ensuite — ${TODAY.format(new Date(`${data.today}T00:00:00Z`))}.`
            : 'Où en sont la base et l’activité de contact, puis quoi faire ensuite.'
        }
        actions={
          <>
            <Link to="/prospection/import" className="btn btn--secondary btn--md">
              <UploadIcon size={18} />
              Importer Excel
            </Link>
            <Link to="/prospection" className="btn btn--primary btn--md">
              <UsersIcon size={18} />
              Ouvrir la prospection
            </Link>
          </>
        }
      />

      {home.isPending && (
        <p className="home__state" role="status">
          <SpinnerIcon size={18} className="btn__spinner" />
          Chargement de l’accueil…
        </p>
      )}
      {home.isError && (
        <div className="home__state home__state--error" role="alert">
          <AlertIcon size={18} />
          Accueil indisponible.
          <Button size="sm" onClick={() => void home.refetch()}>
            Réessayer
          </Button>
        </div>
      )}

      {data && (data.counts.all === 0 ? <EmptyBase /> : <Overview data={data} />)}
      {data && (
        <div className="home-panels">
          {data.counts.all > 0 && <MonthlyProgress progress={data.progress} />}
          <RecentActivity imports={data.recent_imports} edits={data.recent_edits} />
        </div>
      )}

      <p className="home__scope">
        <InfoIcon size={16} />
        L’accueil ne montre que les données de VIPER : imports Excel et saisies manuelles. Les envois d’e-mails,
        Calendly et les agents de prospection ne font pas partie de la V1.
      </p>
    </div>
  )
}
