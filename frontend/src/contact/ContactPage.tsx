import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import { CONTACT_PAGE_SIZE, type ContactCounter, useContactDashboard, useContactPage } from '../api/contact'
import { businessToday } from '../lib/isoWeek'
import { TRACKING_LABELS } from '../prospection/labels'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { CounterCard, CounterGroup } from '../ui/CounterCards'
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, SpinnerIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { ContactFilters } from './ContactFilters'
import { ContactList } from './ContactList'
import {
  type ContactView,
  DEFAULT_VIEW,
  hasFilters,
  listCriteria,
  parseView,
  selectCounter,
  serializeView,
} from './criteria'
import { COUNTER_GROUPS, COUNTER_INFO } from './labels'
import { type Neighbours, Workbench } from './Workbench'
import './contact.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

function peopleCount(count: number): string {
  return `${NUMBER.format(count)} ${count > 1 ? 'prospects' : 'prospect'}`
}

// Where the next actions of the list fall: « cette semaine (S41) », « toutes les semaines », « la semaine S42 de 2026 ».
function weekText(view: ContactView, currentWeek: string | undefined): string {
  if (view.week === 'all') return 'toutes les semaines'
  const week = view.week === 'current' ? currentWeek : view.week
  const label = week ? `S${week.slice(-2)}` : ''
  return view.week === 'current' ? `cette semaine${label ? ` (${label})` : ''}` : `la semaine ${label} de ${week?.slice(0, 4) ?? ''}`
}

// The sentence under the list title: what the list holds.
function resultsHint(view: ContactView, currentWeek: string | undefined): string {
  const parts = [
    view.counter ? COUNTER_INFO[view.counter].hint : `Prospects dont la prochaine action tombe ${weekText(view, currentWeek)}.`,
    view.counter && view.week !== 'all' && `Semaine : ${weekText(view, currentWeek)}.`,
    view.state && `État : ${TRACKING_LABELS[view.state]}.`,
  ]
  return parts.filter(Boolean).join(' ')
}

// Contact (ex-Exploitation, decisions 15-19): who to contact this week and the mail of each step. Counters are filters,
// every criterion lives in the URL (criteria.ts); a person opens the workbench — prospect sheet left, mail sequence
// right — in place of the list.
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
    if (settled === draft && settled !== view.q) update({ q: settled, page: 1 })
  }, [settled, draft, view.q, update])

  const dashboard = useContactDashboard(view.q)
  const currentWeek = dashboard.data?.current_week
  const criteria = listCriteria(view, currentWeek)
  const list = useContactPage(criteria ?? { ...DEFAULT_VIEW, week: null }, view.page, criteria !== null)
  const page = criteria ? list.data : undefined
  const today = dashboard.data?.today ?? businessToday()

  // The prospect whose workbench was closed last: the list gives it the focus back.
  const [returnedFrom, setReturnedFrom] = useState<string | null>(null)
  const [openedId, setOpenedId] = useState<string | null>(view.prospect)
  if (view.prospect !== openedId) {
    if (view.prospect === null) setReturnedFrom(openedId)
    setOpenedId(view.prospect)
  }

  const openHref = (id: string) => `?${serializeView({ ...view, prospect: id }).toString()}`
  const listHref = `?${serializeView({ ...view, prospect: null }).toString()}`

  if (view.prospect !== null) {
    const rows = page?.items ?? []
    const index = rows.findIndex((row) => row.id === view.prospect)
    const neighbours: Neighbours | null =
      index < 0
        ? null
        : {
            position: (page?.offset ?? 0) + index + 1,
            count: page?.total ?? rows.length,
            previous: rows[index - 1]?.id ?? null,
            next: rows[index + 1]?.id ?? null,
          }
    return (
      <div className="contact">
        <PageHeader title="Contact" description="Préparer, valider et programmer les mails de la semaine." />
        <Workbench
          key={view.prospect}
          prospectId={view.prospect}
          listHref={listHref}
          openHref={openHref}
          neighbours={neighbours}
        />
      </div>
    )
  }

  const filtered = hasFilters(view)
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0
  const heading = view.counter ? COUNTER_INFO[view.counter].label : 'Planning de contact'
  function select(counter: ContactCounter) {
    update(selectCounter(view, counter))
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

      <section className="counters contact-counters" aria-label="Compteurs">
        {COUNTER_GROUPS.map((group) => (
          <CounterGroup key={group.id} id={`contact-${group.id}`} title={group.title} className={`contact-counters__${group.id}`}>
            {group.counters.map((counter) => {
              const { label, hint, icon } = COUNTER_INFO[counter]
              return (
                <CounterCard
                  key={counter}
                  label={label}
                  hint={hint}
                  icon={icon}
                  count={dashboard.data?.counts[counter]}
                  pressed={view.counter === counter}
                  onSelect={() => {
                    select(counter)
                  }}
                />
              )
            })}
          </CounterGroup>
        ))}
      </section>

      <ContactFilters
        view={view}
        dashboard={dashboard.data}
        onChange={update}
        search={<SearchField label="Rechercher : nom, entreprise, e-mail, téléphone" value={draft} onChange={setDraft} />}
      />

      <section className="contact__results" aria-labelledby="contact-results-title">
        <div className="contact__results-head">
          <div>
            <h2 id="contact-results-title" className="contact__results-title">
              {heading}
              {page && <span className="contact__results-count">{peopleCount(page.total)}</span>}
              {list.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
            </h2>
            <p className="contact__results-hint">{resultsHint(view, currentWeek)}</p>
          </div>
          {filtered && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft('')
                update(DEFAULT_VIEW)
              }}
            >
              Réinitialiser
            </Button>
          )}
        </div>

        {(list.isPending || criteria === null) && !dashboard.isError && (
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
        {page?.total === 0 && (
          <p className="contact__state">
            {filtered
              ? 'Aucun prospect ne correspond à ces critères.'
              : 'Aucun prospect planifié cette semaine. Planifiez une semaine depuis Prospection, ou choisissez une autre semaine.'}
          </p>
        )}
        {page && page.items.length > 0 && (
          <ContactList rows={page.items} openHref={(id) => openHref(id)} today={today} returnedFrom={returnedFrom} />
        )}
        {page && page.total > CONTACT_PAGE_SIZE && (
          <nav className="contact__pager" aria-label="Pages de la liste">
            <span>
              {page.offset + 1}–{last} sur {NUMBER.format(page.total)}
            </span>
            <Button
              size="sm"
              icon={ChevronLeftIcon}
              disabled={view.page <= 1}
              onClick={() => {
                update({ page: view.page - 1 })
              }}
            >
              Précédents
            </Button>
            <Button
              size="sm"
              icon={ChevronRightIcon}
              disabled={last >= page.total}
              onClick={() => {
                update({ page: view.page + 1 })
              }}
            >
              Suivants
            </Button>
          </nav>
        )}
      </section>
    </div>
  )
}
