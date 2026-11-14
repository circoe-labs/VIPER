import { CONTACT_PAGE_SIZE, type ContactListCriteria } from '../api/contact'
import { Button } from '../ui/Button'
import { AlertIcon, SpinnerIcon } from '../ui/icons'
import { VIEW_META, type ListPlan } from './commercialModel'
import { ContactList } from './ContactList'
import { useCommercialList } from './useCommercialList'

const NUMBER = new Intl.NumberFormat('fr-FR')

interface CommercialListProps {
  plan: ListPlan
  criteria: ContactListCriteria
  filtered: boolean
  // The capsule figure of this view, used as the list's size when the server cannot count it (client-side narrowing).
  capsuleCount: number | null
  currentWeek: string | undefined
  page: number
  onPageChange: (page: number) => void
  openHref: (id: string) => string
  today: string
  returnedFrom: string | null
}

// The list of the active view: title, size, rows with their next step / dates, pagination. Loading, error and empty
// states are said on screen; a read that fails offers a retry.
export function CommercialList({ plan, criteria, filtered, capsuleCount, currentWeek, page, onPageChange, openHref, today, returnedFrom }: CommercialListProps) {
  const meta = VIEW_META[plan.key]
  const list = useCommercialList(plan, criteria, page, currentWeek)
  const rows = list.data?.items ?? []
  const narrowed = meta.clientFilter !== undefined
  // A client-narrowed list is counted by its capsule unless a search/filter makes that figure wrong: then, the rows shown.
  const total = narrowed ? (filtered ? (list.data ? rows.length : null) : capsuleCount) : (list.data?.total ?? null)
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / CONTACT_PAGE_SIZE))
  const titleId = `contact-list-title-${plan.key}`
  return (
    <section className="cohort-section contacts-panel" aria-labelledby={titleId}>
      <h2 className="contacts-panel__heading" id={titleId}>
        <span className="contacts-panel__name">{meta.title}</span>
        <span className="contacts-panel__count">
          {total === null ? '–' : `${NUMBER.format(total)} prospect${total > 1 ? 's' : ''}${narrowed && filtered ? ' affichés' : ''}`}
        </span>
      </h2>
      <div className="cohort-section__body">
        {list.isPending && (
          <p className="contact__state" role="status">
            <SpinnerIcon size={18} className="btn__spinner" /> Chargement de la liste…
          </p>
        )}
        {list.isError && (
          <div className="contact__state contact__state--error" role="alert">
            <AlertIcon size={18} /> Liste indisponible ({list.error.message}).
            <Button size="sm" onClick={() => void list.refetch()}>Réessayer</Button>
          </div>
        )}
        {list.data && rows.length === 0 && (
          <p className="contact__state">{filtered ? 'Aucun prospect ne correspond à la recherche.' : meta.empty}</p>
        )}
        {rows.length > 0 && <ContactList rows={rows} openHref={openHref} today={today} returnedFrom={returnedFrom} planning={meta.planning} label={meta.title} />}
        {pages > 1 && (
          <nav className="contact-pagination" aria-label={`Pagination : ${meta.title}`}>
            <Button size="sm" disabled={page === 1 || list.isFetching} onClick={() => { onPageChange(page - 1) }}>Page précédente</Button>
            <span role="status">Page {NUMBER.format(page)} sur {NUMBER.format(pages)}</span>
            <Button size="sm" disabled={page >= pages || list.isFetching} onClick={() => { onPageChange(page + 1) }}>Page suivante</Button>
          </nav>
        )}
      </div>
    </section>
  )
}
