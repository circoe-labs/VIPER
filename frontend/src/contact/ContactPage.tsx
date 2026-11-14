import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { useContactDashboard, useContactOverview } from '../api/contact'
import { businessToday } from '../lib/isoWeek'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { PlusIcon, RefreshIcon } from '../ui/icons'
import { SelectField } from '../ui/fields'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { CommercialList } from './CommercialList'
import { ContactCapsules } from './ContactCapsules'
import { ContactChart } from './ContactChart'
import { WarehouseContacts } from './WarehouseContacts'
import { activeView, buildCapsules, listPlan, readSummarySource, upcomingWeeks } from './commercialModel'
import { bannerText } from './dispatchCopy'
import { DispatchWarning } from './DispatchWarning'
import { type ContactView, listCriteria, parseView, serializeView } from './criteria'
import { useCommercialWalk } from './useCommercialList'
import { type Neighbours, Workbench } from './Workbench'
import './contact.css'
import './contacts-crm.css'

// Contact: the commercial view. Capsules (to contact, follow-ups, overdue, contacted, replies, appointments, mail
// errors) each open one filtered list; the URL (`?view=`, `week`, search, status, company, `prospect`) holds the state,
// so Home and bookmarks deep-link into it. A person opens the workbench in place of the list.
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
  // The planning counters (capsules, weeks) never follow the search box: a capsule is the size of its whole list.
  const planning = useContactDashboard('')
  const source = readSummarySource(planning.data)
  const capsules = buildCapsules(source)
  const today = dashboard.data?.today ?? planning.data?.today ?? businessToday()
  const key = activeView(view)
  const plan = listPlan(view)
  const criteria = listCriteria(view)
  const walkOrder = useCommercialWalk(plan, criteria, source?.current_week, view.prospect !== null)

  // Filters reset the page; the view and week do too.
  const searched = JSON.stringify([view.q.trim(), view.status, view.company, key, view.week])
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
    `?${serializeView({ ...view, view: key, prospect: id }).toString()}`
  const listHref = `?${serializeView({ ...view, prospect: null }).toString()}`

  if (view.prospect !== null) {
    // The list's whole order, read once when the workbench opens.
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
      <PageHeader mascot="contact" title="Contacts" description="Qui contacter, qui relancer, qui a répondu : le suivi commercial des envois." actions={
        <Link className="btn btn--primary" to="/prospection?prospect=new"><PlusIcon size={18} /> Ajouter un contact</Link>
      } />

      <ContactCapsules capsules={capsules} active={key} loading={planning.isPending} error={planning.isError} onRetry={() => void planning.refetch()} />

      {dashboard.data && !dashboard.data.dispatch.active && dashboard.data.dispatch.scheduled_count > 0 && (
        // S9: scheduled messages the server will not send — said before anything else on the page.
        <DispatchWarning reason={dashboard.data.dispatch.reason} role="alert" className="contact__dispatch-banner">
          {bannerText(dashboard.data.dispatch)}
        </DispatchWarning>
      )}

      <div className="contacts-filters" role="search" aria-label="Rechercher dans la liste">
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

      {key === 'to_contact' && <WeekChoice weeks={upcomingWeeks(source)} value={view.week} onChange={(week) => { update({ week }) }} />}
      {key === 'contacted' && <ContactChart bars={dashboard.data?.bars} total={dashboard.data?.total} loading={dashboard.isPending} error={dashboard.isError} onRetry={() => void dashboard.refetch()} />}
      <CommercialList
        key={searched}
        plan={plan}
        criteria={criteria}
        filtered={Boolean(view.q.trim() || view.status || view.company)}
        capsuleCount={capsules.find((capsule) => capsule.key === key)?.count ?? null}
        currentWeek={source?.current_week}
        page={page}
        onPageChange={setPage}
        openHref={openHref}
        today={today}
        returnedFrom={returnedFrom}
      />
      <WarehouseContacts />
    </div>
  )
}

// « Semaine d'envoi »: the weeks to come that have something planned, so the people to contact in the coming weeks can
// be listed week by week. Empty value = this week, overdue included.
function WeekChoice({ weeks, value, onChange }: { weeks: { week: string; label: string; count: number }[]; value: string | null; onChange: (week: string | null) => void }) {
  if (weeks.length === 0 && value === null) return null
  return (
    <div className="contact-weeks">
      <SelectField label="Semaine d’envoi" value={value ?? ''} onChange={(event) => { onChange(event.target.value || null) }}>
        <option value="">Cette semaine et retards</option>
        {weeks.map((option) => <option value={option.week} key={option.week}>{`${option.label} · ${String(option.count)} prévu${option.count > 1 ? 's' : ''}`}</option>)}
        {value !== null && !weeks.some((option) => option.week === value) && <option value={value}>{value}</option>}
      </SelectField>
    </div>
  )
}
