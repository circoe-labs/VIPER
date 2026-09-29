// Page Contact (Tasks 08-09, décisions 15-19) : langage visuel de Prospection, métriques propres à Contact.
// - Task 09 : `dashboard` = cartes-filtres « À traiter cette semaine » (premier contact / relances / revues R2) et « RDV pris »,
//   filtres semaine ISO (couple année/semaine) et état ; `list` = prospects filtrés, sélectionnables (`selectedProspectId`).
//   Lecture seule : aucun filtre ni clic ne change un état.
// - Task 10 : split view fiche prospect (gauche) / séquence mail (droite) dans `main`, à partir de `selectedProspectId`.
import React, { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { PageTitle } from './PageTitle';
import { TrackingBadges } from './TrackingBadges';
import {
  contactCards, contactStateOptions, emptyListMessage, nextStepLabel, sameContactWeek, toggleCardFilter, weekFilterOptions,
  weekOptionLabel, withWeekFilter, type ContactCard
} from './contactDisplay';
import {
  contactListSearchParams, emptyContactCounters, isContactStateFilter, type ContactDashboard, type ContactListItem, type ContactListQuery
} from '../shared/contactDashboard';

export function ContactWorkspace({ dashboard, list, main }: { dashboard?: ReactNode; list: ReactNode; main: ReactNode }) {
  return <>
    <div className="top"><PageTitle title="Contact" sub="Préparer les prises de contact de la semaine : premier contact, relances R1/R2, rendez-vous obtenus." /></div>
    {dashboard}
    <div className="contact-workspace">
      <section className="contact-list" aria-label="Prospects à traiter">{list}</section>
      <section className="contact-main" aria-label="Prospect sélectionné">{main}</section>
    </div>
  </>;
}

const fullName = (p: Pick<ContactListItem, 'first_name' | 'last_name'>) => [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Nom non renseigné';

function CardButton({ card, active, onClick, className = '' }: { card: ContactCard; active: boolean; onClick: () => void; className?: string }) {
  return <button type="button" className={`${className}${active ? ' active' : ''}`} aria-pressed={active} title={card.title} onClick={onClick}>
    <span>{card.label}</span><b>{card.count}</b>
  </button>;
}

function ContactDashboardBar({ dashboard, query, onChange }: { dashboard: ContactDashboard | null; query: ContactListQuery; onChange: (q: ContactListQuery) => void }) {
  const currentWeek = dashboard?.currentWeek ?? null;
  const cards = contactCards(dashboard?.counters ?? emptyContactCounters, currentWeek);
  const weeks = weekFilterOptions(dashboard?.weeks ?? [], currentWeek);
  const weekValue = query.week ? `${query.week.year}-${query.week.week}` : '';
  const hasFilter = !!(query.filter || query.week || query.status);
  return <>
    <div className="filters contact-counters" role="group" aria-label="Cartes-filtres Contact">
      <div className={`contact-card-group${query.filter === 'to_handle' || cards.breakdown.some(c => c.filter === query.filter) ? ' active' : ''}`}>
        <CardButton card={cards.toHandle} active={query.filter === 'to_handle'} onClick={() => onChange(toggleCardFilter(query, 'to_handle'))} />
        <div className="contact-breakdown">
          {cards.breakdown.map(card => <CardButton key={card.filter} className="small" card={card} active={query.filter === card.filter} onClick={() => onChange(toggleCardFilter(query, card.filter))} />)}
        </div>
      </div>
      <CardButton card={cards.appointments} active={query.filter === 'appointments'} onClick={() => onChange(toggleCardFilter(query, 'appointments'))} />
    </div>
    <div className="prospect-toolbar">
      <label className="sr-only" htmlFor="contact-week-filter">Semaine de prochaine action</label>
      <select id="contact-week-filter" value={weekValue} onChange={e => {
        const option = weeks.find(w => `${w.year}-${w.week}` === e.target.value);
        onChange(withWeekFilter(query, option ? { year: option.year, week: option.week } : undefined));
      }}>
        <option value="">Toutes les semaines planifiées</option>
        {weeks.map(w => <option key={`${w.year}-${w.week}`} value={`${w.year}-${w.week}`}>
          {weekOptionLabel(w, currentWeek)}{sameContactWeek(w, currentWeek ?? undefined) ? ' (cette semaine)' : ''} · {w.count}
        </option>)}
      </select>
      <label className="sr-only" htmlFor="contact-state-filter">État</label>
      <select id="contact-state-filter" value={query.status ?? ''} onChange={e => onChange({ ...query, status: isContactStateFilter(e.target.value) ? e.target.value : undefined })}>
        <option value="">Tous les états</option>
        {contactStateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hasFilter && <button type="button" className="secondary small" onClick={() => onChange({})}>Réinitialiser les filtres</button>}
    </div>
  </>;
}

function ContactList({ items, loading, error, query, selectedId, onSelect, onPlanInProspection }: {
  items: ContactListItem[]; loading: boolean; error: string; query: ContactListQuery; selectedId: string | null;
  onSelect: (id: string) => void; onPlanInProspection: () => void;
}) {
  if (error) return <div className="danger" role="alert">{error}</div>;
  if (loading && !items.length) return <p className="muted">Chargement…</p>;
  if (!items.length) return <div className="empty-list">
    <p>{emptyListMessage(query)}</p>
    <button type="button" className="secondary" onClick={onPlanInProspection}>Planifier depuis Prospection</button>
  </div>;
  return <div className="contact-people" aria-busy={loading}>
    {items.map(p => {
      const step = nextStepLabel(p.tracking_status, p.next_action_year !== null && p.next_action_week !== null);
      return <button type="button" key={p.id} className={selectedId === p.id ? 'active' : ''} aria-pressed={selectedId === p.id} onClick={() => onSelect(p.id)}>
        <div className="avatar" aria-hidden="true">{p.first_name?.[0]}{p.last_name?.[0]}</div>
        <div className="contact-person">
          <b>{fullName(p)}</b>
          <span>{[p.exact_job_title || p.role, p.company].filter(Boolean).join(' · ')}</span>
          <span className="contact-person-tracking"><TrackingBadges status={p.tracking_status} year={p.next_action_year} week={p.next_action_week} />{step && <em>{step}</em>}</span>
        </div>
      </button>;
    })}
  </div>;
}

export function ContactPage({ onPlanInProspection }: { onPlanInProspection: () => void }) {
  const [dashboard, setDashboard] = useState<ContactDashboard | null>(null);
  const [query, setQuery] = useState<ContactListQuery>({});
  // Dernier résultat reçu, avec la requête qui l'a produit : la liste est « en chargement » tant qu'il ne correspond pas aux filtres.
  const [result, setResult] = useState<{ key: string | null; items: ContactListItem[]; error: string }>({ key: null, items: [], error: '' });
  const [dashboardError, setDashboardError] = useState('');
  // Sélection exposée à la Task 10 (split view dans `main`) ; un filtre ne la réinitialise pas.
  const [selectedProspectId, setSelectedProspectId] = useState<string | null>(null);

  const queryKey = contactListSearchParams(query);
  const loading = result.key !== queryKey;
  const items = result.items;
  const error = dashboardError || (loading ? '' : result.error);

  useEffect(() => { api<ContactDashboard>('/api/contact/dashboard').then(setDashboard).catch(e => setDashboardError((e as Error).message)); }, []);
  useEffect(() => {
    let current = true;
    api<ContactListItem[]>(`/api/contact/prospects?${queryKey}`)
      .then(rows => { if (current) setResult({ key: queryKey, items: rows, error: '' }); })
      .catch(e => { if (current) setResult(r => ({ key: queryKey, items: r.items, error: (e as Error).message })); });
    return () => { current = false; };
  }, [queryKey]);

  const selected = items.find(p => p.id === selectedProspectId) ?? null;
  return <ContactWorkspace
    dashboard={<ContactDashboardBar dashboard={dashboard} query={query} onChange={setQuery} />}
    list={<ContactList items={items} loading={loading} error={error} query={query} selectedId={selectedProspectId} onSelect={setSelectedProspectId} onPlanInProspection={onPlanInProspection} />}
    main={<div className="empty-list contact-main-empty" aria-live="polite">
      {selectedProspectId ? `${selected ? fullName(selected) : 'Prospect'} sélectionné. La fiche et la séquence mail arrivent ici.` : 'Aucun prospect sélectionné.'}
    </div>}
  />;
}
