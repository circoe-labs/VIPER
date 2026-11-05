import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { CONTACTED, useContactOverview, useContactWalk } from '../api/contact'
import { businessToday } from '../lib/isoWeek'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { PlusIcon, RefreshIcon } from '../ui/icons'
import { SelectField } from '../ui/fields'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { ContactedSection } from './ContactedSection'
import { ContactChart } from './ContactChart'
import { bannerText } from './dispatchCopy'
import { DispatchWarning } from './DispatchWarning'
import { type ContactView, listCriteria, parseView, serializeView } from './criteria'
import { type Neighbours, Workbench } from './Workbench'
import './contact.css'
import './contacts-crm.css'

// Contact: one searchable category of already contacted prospects, across every cohort and sequence.
// A person opens the workbench in place of the list; the URL preserves search and the open prospect.
export function ContactPage() {
  const [params, setParams] = useSearchParams()
  const view = parseView(params)

  const update = useCallback(
    (patch: Partial<ContactView>, { push = false } = {}) => {
      setParams((current) => serializeView({ ...parseView(current), ...patch }), { replace: !push })
    },
    [setParams],
  )

  // The search box types freely; the URL follows once typing pauses, and a URL change (Back, reset) refills the box.
  const [draft, setDraft] = useState(view.q)
  const [urlSearch, setUrlSearch] = useState(view.q)
  if (view.q !== urlSearch) {
    setUrlSearch(view.q)
    setDraft(view.q)
  }
  const settled = useDebouncedValue(draft, 250)
  useEffect(() => {
    if (settled === draft && settled !== view.q) update({ q: settled })
  }, [settled, draft, view.q, update])

  const dashboard = useContactOverview(listCriteria(view))
  const today = dashboard.data?.today ?? businessToday()
  const walkOrder = useContactWalk(listCriteria(view), view.prospect !== null)

  // The category starts closed; filters reset the page without changing the user's expansion.
  const searched = JSON.stringify([view.q.trim(), view.status, view.company])
  const [open, setOpen] = useState(view.section === CONTACTED)
  const [page, setPage] = useState(1)
  const [collapsedFor, setCollapsedFor] = useState(searched)
  if (searched !== collapsedFor) {
    setCollapsedFor(searched)
    setPage(1)
  }

  // The prospect whose workbench was closed last: the list gives it the focus back.
  const [returnedFrom, setReturnedFrom] = useState<string | null>(null)
  const [openedId, setOpenedId] = useState<string | null>(view.prospect)
  if (view.prospect !== openedId) {
    if (view.prospect === null) setReturnedFrom(openedId)
    setOpenedId(view.prospect)
  }

  const openHref = (id: string) =>
    `?${serializeView({ ...view, section: CONTACTED, prospect: id }).toString()}`
  const listHref = `?${serializeView({ ...view, prospect: null }).toString()}`

  if (view.prospect !== null) {
    // The category's whole order, read once when the workbench opens.
    const ids = walkOrder.data ?? []
    const index = ids.indexOf(view.prospect)
    const neighbours: Neighbours | null =
      index < 0
        ? null
        : {
            position: index + 1,
            count: ids.length,
            previous: ids[index - 1] ?? null,
            next: ids[index + 1] ?? null,
          }
    return (
      <div className="contact contact--bench contact--crm">
        {/* The workbench fits one screen: the page's own title and sentence give way to the work. */}
        <h1 className="visually-hidden">Contacts</h1>
        <Workbench
          key={view.prospect}
          prospectId={view.prospect}
          listHref={listHref}
          openHref={(id) => openHref(id)}
          neighbours={neighbours}
        />
      </div>
    )
  }

  return (
    <div className="contact contact--crm">
      <PageHeader title="Contacts" description="Retrouvez les prospects déjà contactés et suivez vos échanges." actions={
        <Link className="btn btn--primary" to="/prospection?prospect=new"><PlusIcon size={18} /> Ajouter un contact</Link>
      } />

      <ContactChart bars={dashboard.data?.bars} total={dashboard.data?.total} loading={dashboard.isPending} error={dashboard.isError} onRetry={() => void dashboard.refetch()} />

      {dashboard.data && !dashboard.data.dispatch.active && dashboard.data.dispatch.scheduled_count > 0 && (
        // S9: scheduled messages the server will not send — said before anything else on the page.
        <DispatchWarning reason={dashboard.data.dispatch.reason} role="alert" className="contact__dispatch-banner">
          {bannerText(dashboard.data.dispatch)}
        </DispatchWarning>
      )}

      <div className="contacts-filters" role="search" aria-label="Rechercher dans les prospects contactés">
        <div className="contacts-filters__search">
          <SearchField label="Rechercher : nom, entreprise, e-mail, téléphone..." value={draft} onChange={setDraft} />
        </div>
        <SelectField label="Statut" value={view.status ?? ''} onChange={(event) => { update({ status: event.target.value || null }) }}>
          <option value="">Tous les statuts</option>
          {dashboard.data?.statuses.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </SelectField>
        <SelectField label="Entreprise" value={view.company ?? ''} onChange={(event) => { update({ company: event.target.value || null }) }}>
          <option value="">Toutes les entreprises</option>
          <option value="none">Sans entreprise</option>
          {dashboard.data?.companies.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
        </SelectField>
        <Button icon={RefreshIcon} onClick={() => {
          setDraft('')
          update({ q: '', status: null, company: null })
        }}>Réinitialiser</Button>
      </div>

      <ContactedSection
        key={searched}
        view={view}
        count={dashboard.data?.total}
        open={open}
        onToggle={() => { setOpen(!open); }}
        page={page}
        onPageChange={setPage}
        openHref={openHref}
        today={today}
        returnedFrom={returnedFrom}
      />
    </div>
  )
}
