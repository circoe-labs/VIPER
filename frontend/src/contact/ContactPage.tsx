import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import {
  APPOINTMENTS,
  CONTACT_SECTIONS,
  type ContactSection,
  useContactDashboard,
  useContactWalk,
} from '../api/contact'
import { businessToday } from '../lib/isoWeek'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { AlertIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { CohortSection } from './CohortSection'
import { cohortStatus, sentSummary } from './cohortStatus'
import { bannerText } from './dispatchCopy'
import { DispatchWarning } from './DispatchWarning'
import { type ContactView, listCriteria, parseView, serializeView } from './criteria'
import { SchedulingOverview } from './SchedulingOverview'
import { type Neighbours, Workbench } from './Workbench'
import './contact.css'

// Contact (ex-Exploitation): one section per cohort of the campaign (S39 … S45), each opened or closed with its arrow and
// listing its prospects alphabetically by company. A person opens the workbench — prospect sheet left, mail sequence
// right — in place of the list; the search box narrows every section, and what shows lives in the URL (criteria.ts).
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

  const dashboard = useContactDashboard(view.q)
  const today = dashboard.data?.today ?? businessToday()
  const walkOrder = useContactWalk(view.section ? listCriteria(view) : null, view.prospect !== null)

  // The sections open; the one a workbench was opened from is open again when it closes.
  const [opened, setOpened] = useState<ReadonlySet<ContactSection>>(() => new Set(view.section ? [view.section] : []))
  function toggle(code: ContactSection) {
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(code)) next.add(code)
      return next
    })
  }

  // The prospect whose workbench was closed last: the list gives it the focus back.
  const [returnedFrom, setReturnedFrom] = useState<string | null>(null)
  const [openedId, setOpenedId] = useState<string | null>(view.prospect)
  if (view.prospect !== openedId) {
    if (view.prospect === null) setReturnedFrom(openedId)
    setOpenedId(view.prospect)
  }

  const openHref = (id: string, section: ContactSection | null = view.section) =>
    `?${serializeView({ ...view, section, prospect: id }).toString()}`
  const listHref = `?${serializeView({ ...view, prospect: null }).toString()}`

  if (view.prospect !== null) {
    // The cohort's whole order, read once when the workbench opens.
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
      <div className="contact">
        <PageHeader title="Contact" description="Préparer, valider et programmer les mails de la semaine." />
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
    <div className="contact">
      <PageHeader title="Contact" description="Préparer, valider et programmer les mails de la semaine." />

      {dashboard.isError && (
        <div className="contact__state contact__state--error" role="alert">
          <AlertIcon size={18} />
          Compteurs indisponibles ({dashboard.error.message}).
          <Button size="sm" onClick={() => void dashboard.refetch()}>
            Réessayer
          </Button>
        </div>
      )}

      {dashboard.data && !dashboard.data.dispatch.active && dashboard.data.dispatch.scheduled_count > 0 && (
        // S9: scheduled messages the server will not send — said before anything else on the page.
        <DispatchWarning reason={dashboard.data.dispatch.reason} role="alert" className="contact__dispatch-banner">
          {bannerText(dashboard.data.dispatch)}
        </DispatchWarning>
      )}

      <div className="contact-toolbar" role="search" aria-label="Rechercher dans les cohortes">
        <div className="contact-toolbar__search">
          <SearchField label="Rechercher : nom, entreprise, e-mail, téléphone" value={draft} onChange={setDraft} />
        </div>
      </div>

      <SchedulingOverview openHref={(id) => openHref(id, null)} />

      <div className="cohort-sections">
        {CONTACT_SECTIONS.map((code) => {
          const cohorts = dashboard.data?.cohorts ?? []
          const appointments =
            dashboard.data?.categories?.find((item) => item.category === 'appointment_obtained')?.count ?? 0
          const summary = cohorts.find((cohort) => cohort.code === code)
          return (
            <CohortSection
              key={code}
              code={code}
              title={code === APPOINTMENTS ? 'RDV pris' : code}
              view={view}
              count={
                dashboard.data
                  ? code === APPOINTMENTS
                    ? appointments
                    : Math.max((summary?.prospects ?? 0) - (summary?.appointments ?? 0), 0)
                  : undefined
              }
              status={
                dashboard.data && code !== APPOINTMENTS
                  ? cohortStatus(code, cohorts, dashboard.data.today || businessToday())
                  : undefined
              }
              sent={dashboard.data && code !== APPOINTMENTS ? sentSummary(code, cohorts) : null}
              open={opened.has(code)}
              onToggle={() => {
                toggle(code)
              }}
              openHref={(id) => openHref(id, code)}
              today={today}
              returnedFrom={returnedFrom}
            />
          )
        })}
      </div>
    </div>
  )
}
