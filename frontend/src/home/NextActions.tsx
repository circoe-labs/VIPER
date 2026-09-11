import { Link } from 'react-router'

import type { ActionGroup, ActionItem, HomeData } from '../api/home'
import type { ProspectSort, Segment } from '../api/prospection'
import { prospectionHref } from '../prospection/criteria'
import { personName, TRACKING_LABELS } from '../prospection/labels'
import { ChevronRightIcon } from '../ui/icons'
import { formatMoment } from './activity'

type GroupKey = keyof HomeData['next_actions']

interface GroupSpec {
  key: GroupKey
  title: string
  empty: string
  // The Prospection list each person opens in (so « Enregistrer et suivant » walks the same queue).
  segment: Segment
  sort?: ProspectSort
  more: string
  when: (item: ActionItem) => string | null
  // Whether the current stage says more than the group title (every due contact is « À contacter »).
  stage: boolean
}

// Priority order (doc/features/home-dashboard.md): time-bound appointments first, then overdue contacts, then answers
// still waiting for an appointment. Within a group, the oldest (or soonest) first — no other ranking is invented.
const GROUPS: GroupSpec[] = [
  {
    key: 'appointments',
    title: 'Rendez-vous des 7 prochains jours',
    empty: 'Aucun rendez-vous prévu d’ici 7 jours.',
    segment: 'appointments',
    more: 'Tous les rendez-vous',
    when: (item) => (item.at ? `Rendez-vous le ${formatMoment(item.at)}` : null),
    stage: true,
  },
  {
    key: 'due',
    title: 'Contacts échus',
    empty: 'Aucun contact prévu au plus tard aujourd’hui.',
    segment: 'due',
    sort: 'planned_contact',
    more: 'Tous les échus',
    when: (item) => (item.at ? `Prévu le ${formatMoment(item.at)}` : null),
    stage: false,
  },
  {
    key: 'responses',
    title: 'Réponses sans rendez-vous',
    empty: 'Aucune réponse en attente d’un rendez-vous.',
    segment: 'responses',
    more: 'Toutes les réponses',
    when: (item) => (item.at ? `Réponse le ${formatMoment(item.at)}` : null),
    stage: true,
  },
]

function listView(spec: GroupSpec) {
  return spec.sort ? { segment: spec.segment, sort: spec.sort } : { segment: spec.segment }
}

function ActionList({ spec, group }: { spec: GroupSpec; group: ActionGroup }) {
  const titleId = `home-actions-${spec.key}`
  return (
    <div className="action-group">
      <h3 id={titleId} className="action-group__title">
        {spec.title}
        <span className="action-group__count">{group.total}</span>
      </h3>
      {group.items.length === 0 ? (
        <p className="action-group__empty">{spec.empty}</p>
      ) : (
        <ul className="action-group__list" aria-labelledby={titleId}>
          {group.items.map((item) => {
            const meta = [
              spec.when(item),
              spec.stage && item.tracking_status && TRACKING_LABELS[item.tracking_status],
              item.referent_name && `Référent : ${item.referent_name}`,
            ]
            return (
              <li key={item.prospect_id} className="action-item">
                <Link
                  className="action-item__name"
                  to={prospectionHref({ ...listView(spec), prospect: item.prospect_id })}
                >
                  {personName(item) || 'Prospect sans nom'}
                </Link>
                {item.company_name && <span className="action-item__company">{item.company_name}</span>}
                <span className="action-item__meta">{meta.filter(Boolean).join(' · ')}</span>
              </li>
            )
          })}
        </ul>
      )}
      {group.total > 0 && (
        <Link className="action-group__more" to={prospectionHref(listView(spec))}>
          {spec.more}
          <ChevronRightIcon size={14} />
        </Link>
      )}
    </div>
  )
}

// Next actions (Task 16): three short lists from real tracking data; each person opens in Prospection.
export function NextActions({ actions }: { actions: HomeData['next_actions'] }) {
  return (
    <section className="home-panel home-actions" aria-labelledby="home-actions-title">
      <header className="home-panel__header">
        <h2 id="home-actions-title" className="home-panel__title">
          Prochaines actions
        </h2>
      </header>
      <div className="home-actions__groups">
        {GROUPS.map((spec) => (
          <ActionList key={spec.key} spec={spec} group={actions[spec.key]} />
        ))}
      </div>
    </section>
  )
}
