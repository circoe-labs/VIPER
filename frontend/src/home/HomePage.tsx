import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { type HomeData, useHome } from '../api/home'
import type { Segment } from '../api/prospection'
import { prospectionHref } from '../prospection/criteria'
import { SEGMENT_INFO } from '../prospection/labels'
import { useProspectEditor } from '../prospection/prospectEditor'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  type IconComponent,
  InfoIcon,
  MailIcon,
  PlusIcon,
  SpinnerIcon,
  UploadIcon,
  UsersIcon,
} from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { MonthlyProgress } from './MonthlyProgress'
import { RecentActivity } from './RecentActivity'
import { WeekToContact } from './WeekToContact'
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
  // Absent when no Prospection list answers the card's definition.
  href?: string
  // A non-zero count asks for work (verification, due contacts): its glyph takes the warning colour.
  attention?: boolean
}

// Every count that is a Prospection segment opens Prospection on it, where the counter shows the same number (same
// API semantics).
function segmentKpi(data: HomeData, segment: Segment, label: string, attention = false): Kpi {
  const { hint, icon } = SEGMENT_INFO[segment]
  return { label, hint, icon, count: data.counts[segment], href: prospectionHref({ segment }), attention }
}

function KpiCard({ label, hint, icon: Icon, count, href, attention = false }: Kpi) {
  const className = `kpi-card${attention && count > 0 ? ' kpi-card--attention' : ''}`
  const content = (
    <>
      <span className="kpi-card__label">
        <Icon size={14} />
        {label}
      </span>
      <span className="kpi-card__count">{NUMBER.format(count)}</span>
    </>
  )
  return (
    <li>
      {href ? (
        <Link to={href} className={className} title={hint}>
          {content}
        </Link>
      ) : (
        <div className={className} title={hint}>
          {content}
        </div>
      )}
    </li>
  )
}

// Answers recorded this week against the week before: a green arrow up when they hold or rise, a red one down when
// they fall.
function ResponseTrend({ figures }: { figures: HomeData['figures'] }) {
  const { responses_this_week: now, responses_last_week: before } = figures
  const falling = now < before
  const Arrow = falling ? ArrowDownIcon : ArrowUpIcon
  const text = `${String(now)} cette semaine, ${String(before)} la semaine passée`
  return (
    <li>
      <div className="kpi-card" title="Réponses de prospects enregistrées cette semaine, comparées à la semaine passée.">
        <span className="kpi-card__label">
          <MailIcon size={14} />
          Réponses
        </span>
        <span className="kpi-card__count kpi-trend" data-direction={falling ? 'down' : 'up'}>
          {NUMBER.format(now)}
          <Arrow size={20} aria-hidden="true" />
          <span className="visually-hidden">{falling ? 'En baisse' : 'En hausse ou stable'} : {text}</span>
        </span>
        <span className="kpi-trend__detail" aria-hidden="true">
          {text}
        </span>
      </div>
    </li>
  )
}

function KpiList({ id, kpis, children }: { id: string; kpis: Kpi[]; children?: ReactNode }) {
  return (
    <ul className="kpi-group__cards" aria-labelledby={id}>
      {kpis.map((kpi) => (
        <KpiCard key={kpi.label} {...kpi} />
      ))}
      {children}
    </ul>
  )
}

function Overview({ data }: { data: HomeData }) {
  const { figures } = data
  const base: Kpi[] = [
    segmentKpi(data, 'all', 'Prospects'),
    segmentKpi(data, 'appointments', 'RDV confirmé'),
    {
      label: 'Défaillant',
      hint: 'Sans réponse après la dernière relance : à ne plus relancer.',
      icon: BanIcon,
      count: figures.disqualified,
    },
    {
      label: 'À vérifier',
      hint: 'Informations incomplètes : il manque une adresse e-mail ou un numéro de téléphone.',
      icon: AlertIcon,
      count: figures.incomplete,
      attention: true,
    },
  ]
  const contact: Kpi[] = [
    segmentKpi(data, 'due', 'À contacter', true),
    segmentKpi(data, 'no_response', 'Sans réponse'),
    segmentKpi(data, 'appointments', 'RDV'),
    {
      label: 'Mail inactif',
      hint: 'Toujours en poste, mais les e-mails envoyés reviennent : il faut trouver sa nouvelle adresse.',
      icon: MailIcon,
      count: figures.mail_inactive,
      attention: true,
    },
  ]
  return (
    <>
      <section className="home-section" aria-labelledby="home-base-title">
        <h2 id="home-base-title" className="home-section__title">
          Base
        </h2>
        <KpiList id="home-base-title" kpis={base}>
          <ResponseTrend figures={figures} />
        </KpiList>
      </section>

      <section className="home-section" aria-labelledby="home-contact-title">
        <h2 id="home-contact-title" className="home-section__title">
          Activité de contact
        </h2>
        <KpiList id="home-contact-title" kpis={contact} />
      </section>

      <WeekToContact today={data.today} />
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
            ? `Où en sont la base et l’activité de contact — ${TODAY.format(new Date(`${data.today}T00:00:00Z`))}.`
            : 'Où en sont la base et l’activité de contact.'
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
          {data.counts.all > 0 && <MonthlyProgress progress={data.progress} figures={data.figures} />}
          <RecentActivity imports={data.recent_imports} edits={data.recent_edits} />
        </div>
      )}

      <p className="home__scope">
        <InfoIcon size={16} />
        L’accueil ne montre que les données de VIPER : imports Excel, saisies manuelles et envois déclarés. L’envoi
        automatique des e-mails, Calendly et les agents de prospection ne font pas partie de la V1.
      </p>
    </div>
  )
}
