import { CONTACT_PAGE_SIZE, useContactPage } from '../api/contact'
import { Button } from '../ui/Button'
import { AlertIcon, ChevronDownIcon, SpinnerIcon } from '../ui/icons'
import { ContactList } from './ContactList'
import { listCriteria, type ContactView } from './criteria'

const NUMBER = new Intl.NumberFormat('fr-FR')

interface ContactedSectionProps {
  view: ContactView
  count: number | undefined
  open: boolean
  onToggle: () => void
  page: number
  onPageChange: (page: number) => void
  openHref: (id: string) => string
  today: string
  returnedFrom: string | null
}

export function ContactedSection({ view, count, open, onToggle, page, onPageChange, openHref, today, returnedFrom }: ContactedSectionProps) {
  const list = useContactPage(listCriteria(view), page, open)
  const rows = list.data?.items ?? []
  const total = list.data?.total ?? count
  const pages = Math.max(1, Math.ceil((total ?? 0) / CONTACT_PAGE_SIZE))

  return (
    <section className="cohort-section contacts-panel" aria-labelledby="contacted-title">
      <h2 className="cohort-section__heading" id="contacted-title">
        <button type="button" className="cohort-section__toggle" aria-expanded={open} aria-controls="contacted-list" onClick={onToggle}>
          <span className="cohort-section__name">
            <ChevronDownIcon size={18} className="cohort-section__arrow" />
            <span className="cohort-section__code">Prospects contactés</span>
            <span className="cohort-section__count">
              {total === undefined ? '–' : `${NUMBER.format(total)} prospect${total > 1 ? 's' : ''}`}
            </span>
          </span>
        </button>
      </h2>
      {open && (
        <div id="contacted-list" className="cohort-section__body">
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
          {list.data?.total === 0 && (
            <p className="contact__state">
              {view.q.trim() || view.status || view.company ? 'Aucun prospect contacté ne correspond à la recherche.' : 'Aucun prospect contacté pour le moment.'}
            </p>
          )}
          {rows.length > 0 && <ContactList rows={rows} openHref={openHref} today={today} returnedFrom={returnedFrom} />}
          {pages > 1 && (
            <nav className="contact-pagination" aria-label="Pagination des prospects contactés">
              <Button size="sm" disabled={page === 1 || list.isFetching} onClick={() => { onPageChange(page - 1); }}>Page précédente</Button>
              <span role="status">Page {NUMBER.format(page)} sur {NUMBER.format(pages)}</span>
              <Button size="sm" disabled={page >= pages || list.isFetching} onClick={() => { onPageChange(page + 1); }}>Page suivante</Button>
            </nav>
          )}
        </div>
      )}
    </section>
  )
}
