import { APPOINTMENTS, type ContactSection, useContactPage } from '../api/contact'
import { Button } from '../ui/Button'
import { AlertIcon, ChevronDownIcon, SpinnerIcon } from '../ui/icons'
import type { CohortStatus } from './cohortStatus'
import { ContactList } from './ContactList'
import { ScheduleCohorts } from './ScheduleCohorts'
import { listCriteria, type ContactView } from './criteria'

const NUMBER = new Intl.NumberFormat('fr-FR')

function peopleCount(count: number): string {
  return `${NUMBER.format(count)} ${count > 1 ? 'prospects' : 'prospect'}`
}

interface CohortSectionProps {
  code: ContactSection
  // The header's title: the cohort's code, or « RDV pris ».
  title: string
  view: ContactView
  // The cohort's prospects (the dashboard's count, which follows the search); undefined while it loads.
  count: number | undefined
  // What the cohort has to prepare and how the week stands; undefined while the planning loads.
  status: CohortStatus | undefined
  // What has already left the cohort and when (« Contact le 07/09 (44) · R1 le 21/09 (43) »); null before any send.
  sent?: string | null
  open: boolean
  onToggle: () => void
  openHref: (id: string) => string
  today: string
  returnedFrom: string | null
  // The step still to schedule (null: everything is sent or scheduled); undefined while the planning loads.
  nextStep?: string | null
}

// One cohort of the campaign: a header with an arrow that opens or closes it, then its prospects, alphabetical by
// company. Nothing is read from the API while the section stays closed.
export function CohortSection({
  code,
  title,
  view,
  count,
  status,
  sent,
  open,
  onToggle,
  openHref,
  today,
  returnedFrom,
  nextStep,
}: CohortSectionProps) {
  const list = useContactPage(listCriteria(view, code), 1, open)
  const rows = list.data?.items ?? []
  const bodyId = `cohort-${code}`
  return (
    <section className="cohort-section" aria-labelledby={`${bodyId}-title`}>
      <h2 className="cohort-section__heading" id={`${bodyId}-title`}>
        <button
          type="button"
          className="cohort-section__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="cohort-section__name">
            <ChevronDownIcon size={18} className="cohort-section__arrow" />
            <span className="cohort-section__code">{title}</span>
            <span className="cohort-section__count">{count === undefined ? '–' : peopleCount(count)}</span>
          </span>
          <span className="cohort-section__status">{status?.label}</span>
        </button>
      </h2>
      {sent && (
        <p className="cohort-section__sent">
          <span className="cohort-section__sent-label">Déjà envoyé :</span> {sent}
        </p>
      )}
      {code !== APPOINTMENTS && (
        <div className="cohort-section__action">
          <ScheduleCohorts cohort={code} nextStep={nextStep} />
        </div>
      )}
      {open && (
        <div id={bodyId} className="cohort-section__body">
          {list.isPending && (
            <p className="contact__state" role="status">
              <SpinnerIcon size={18} className="btn__spinner" />
              Chargement de la liste…
            </p>
          )}
          {list.isError && (
            <div className="contact__state contact__state--error" role="alert">
              <AlertIcon size={18} />
              Liste indisponible ({list.error.message}).
              <Button size="sm" onClick={() => void list.refetch()}>
                Réessayer
              </Button>
            </div>
          )}
          {list.data?.total === 0 && (
            <p className="contact__state">
              {view.q.trim()
                ? 'Aucun prospect de cette cohorte ne correspond à la recherche.'
                : 'Aucun prospect dans cette cohorte pour le moment.'}
            </p>
          )}
          {rows.length > 0 && <ContactList rows={rows} openHref={openHref} today={today} returnedFrom={returnedFrom} />}
          {list.data && list.data.total > rows.length && (
            <p className="contact__state">
              {NUMBER.format(rows.length)} premiers prospects affichés sur {NUMBER.format(list.data.total)} : affinez
              avec la recherche.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
