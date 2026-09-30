import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { commitWorkbookPreview, previewWorkbook } from './importCache';
import { hasServerBusinessState, requestPersistentBrowserStorage, restoreLatestViperState, saveCurrentViperState } from './stateCache';
import { deleteDraft, hasDraft, loadDraft, saveDraft } from './draftCache';
import { isProspectState, isTerminalProspectState, prospectStates } from '../shared/contactWorkflow';
import { StateBadge, TrackingBadges, WeekBadge } from './TrackingBadges';
import { historyStatusLabel, selectableState, stateOptionLabel } from './trackingDisplay';
import { WeekPlanner } from './WeekPlanner';
import { withoutPlannedWeek } from './weekPlanning';
import { emptyProspectionCounters, prospectionCards } from './prospectionDisplay';
import { cohortSchedule, monthPie, responseTrendView } from './homeDisplay';
import type { ProspectionCounters } from '../shared/prospectionDashboard';
import { loadStoredPage, nav, PROSPECTION_SELECTED_KEY, storePage, storeProspectionSelection, type Page } from './navigation';
import { ContactPage } from './ContactPage';
import { PageTitle } from './PageTitle';
import { ToolboxSettings } from './ToolboxSettings';
import { normalizeServerTimestamp } from './serverDate';
import type {
  CompanyListItem, CompanyRow, EmailRow, HomeDashboard, ImportPreview, LabelRow, PhoneRow, ProspectDetail, ProspectListItem, ProspectRow, ReferentRow,
  SearchResult, TableGrid, TrackingHistoryRow, TrackingRow
} from './apiTypes';

// Fiche éditée : colonnes du prospect (absentes pour une création) + sous-objets ; `is_primary` vaut 0/1 (serveur) ou booléen (radio).
type ContactPointForm<T> = Omit<Partial<T>, 'is_primary'> & { is_primary?: number | boolean };
type EmailForm = ContactPointForm<EmailRow>;
type PhoneForm = ContactPointForm<PhoneRow>;
type TrackingForm = Partial<TrackingRow>;
type ProspectForm = Partial<ProspectRow> & { tracking: TrackingForm; emails: EmailForm[]; phones: PhoneForm[]; trackingHistory?: TrackingHistoryRow[]; company?: CompanyRow | null };
// Détail enregistré ; son suivi est complété par les réponses de `PATCH .../tracking` (WeekPlanner), d'où `Partial`.
type SavedProspect = Partial<Omit<ProspectDetail, 'tracking'>> & { tracking?: TrackingForm | null };
type DrawerTab = 'identity' | 'tracking' | 'history';
// `contact` : ancien onglet Coordonnées (regroupé dans Identité), encore possible dans un brouillon enregistré avant la fusion.
type ProspectDraft = { form: ProspectForm; tab?: DrawerTab | 'contact' };

const IMPORT_DRAFT_KEY = 'import-preview';

const formatDate = (value?: string | null, withTime = false) => {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : normalizeServerTimestamp(value));
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
};

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('commercial@example.test');
  const [password, setPassword] = useState('change-me-now');
  const [error, setError] = useState('');
  return <div className="login"><form onSubmit={async e => {
    e.preventDefault();
    try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); onDone(); }
    catch (x) { setError((x as Error).message); }
  }}>
    <img src="/viper-lockup.svg" />
    <p>Validation Interface for Prospecting, Execution & Revenue</p>
    <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
    <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mot de passe" />
    {error && <span className="error">{error}</span>}
    <button>Se connecter</button>
  </form></div>;
}

function Shell() {
  const [page, setPage] = useState<Page>(() => loadStoredPage(localStorage));
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  useEffect(() => { storePage(localStorage, page); }, [page]);
  useEffect(() => {
    const t = setTimeout(() => search.trim() ? api<SearchResult[]>('/api/search?q=' + encodeURIComponent(search)).then(setResults) : setResults([]), 180);
    return () => clearTimeout(t);
  }, [search]);
  return <div className="app">
    <aside><div className="brand"><img src="/viper-mark.svg" /><b>VIPER</b></div>
      {nav.map(([id, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>{label}</button>)}
      <small>V1 · pilote humain<br />Agents désactivés</small>
    </aside>
    <main><header>
      <div className="search"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher un prospect ou une entreprise…" />
        {results.length > 0 && <div>{results.map(r => <button key={r.type + r.id} onClick={() => { setPage(r.type === 'prospect' ? 'prospection' : 'settings'); setSearch(''); setResults([]); }}><b>{r.label}</b><span>{r.detail}</span></button>)}</div>}
      </div><span>Commercial VIPER</span>
    </header><section>
      {page === 'home' && <Home onProspection={() => setPage('prospection')} onContact={() => setPage('contact')} />}
      {page === 'prospection' && <Prospection />}
      {page === 'contact' && <ContactPage onPlanInProspection={() => setPage('prospection')} onOpenInProspection={id => { storeProspectionSelection(localStorage, id); setPage('prospection'); }} />}
      {page === 'database' && <Database />}
      {page === 'settings' && <Settings />}
    </section></main>
  </div>;
}

function Home({ onProspection, onContact }: { onProspection: () => void; onContact: () => void }) {
  const [d, setD] = useState<HomeDashboard>();
  useEffect(() => { api<HomeDashboard>('/api/dashboard').then(setD); }, []);
  if (!d) return <p>Chargement…</p>;
  const trend = responseTrendView(d.responseTrend);
  const pie = monthPie(d.month);
  const baseCards: [string, number, string, () => void][] = [
    ['Prospects', d.total, 'Tous les prospects en base', onProspection],
    ['RDV confirmés', d.appointments, 'État « RDV pris »', onContact],
    ['Défaillants (Failure)', d.failures, 'État « Failure » posé par un humain (aucun passage automatique)', onContact],
    ['À vérifier', d.incompleteContact, 'Email principal ou téléphone principal manquant', onProspection]
  ];
  const activityCards: [string, number, string][] = [
    ['À contacter', d.activity.inSequence, 'Séquence en cours : Contacté, R1, R2, ou sans état avec une semaine planifiée'],
    ['Sans réponse', d.activity.withoutResponse, 'Contacté, R1 ou R2 sans réponse enregistrée'],
    ['RDV', d.activity.appointments, 'État « RDV pris »']
  ];
  const dayFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return <><PageTitle title="Vue d’ensemble" sub="Pilotage synthétique de la base et de l’activité de contact." />
    <div className="section-label">BASE</div>
    <div className="base-grid">
      {baseCards.map(([label, value, title, go]) => <button className="metric-card" title={title} onClick={go} key={label}><span>{label}</span><b>{value}</b></button>)}
      <div className={`trend-card ${trend.tone}`} title="Réponses (Réponse reçue ou RDV pris) des 7 derniers jours comparées aux 7 jours précédents">
        <span>Réponses vs semaine passée</span>
        <div><b aria-hidden="true">{trend.arrow}</b><strong>{trend.label}</strong></div>
        <small>{d.responseTrend.current} sur 7 jours · {d.responseTrend.previous} la semaine d’avant</small>
      </div>
    </div>
    <div className="section-label home-section-gap">Activité de contact</div>
    <div className="activity-grid">{activityCards.map(([label, value, title]) => <button className="metric-card" title={title} onClick={onContact} key={label}><span>{label}</span><b>{value}</b></button>)}</div>
    <div className="home-grid">
      <Panel title="Progression du mois">
        <div className="pie-wrap">
          <div className="pie-chart" style={{ background: pie.background }} role="img" aria-label={pie.segments.map(s => `${s.label} : ${s.value}`).join(', ')}><span>{pie.total}</span></div>
          <div className="pie-legend">{pie.segments.map(s => <span key={s.key}><i className="legend-dot" style={{ background: s.color }} />{s.label} <b>{s.value}</b></span>)}</div>
        </div>
        <p className="muted">États posés par un humain depuis le 1er du mois.</p>
      </Panel>
      <Panel title="Planning de contact">
        <div className="week-schedule">{cohortSchedule(new Date()).map(item => <div className="week-schedule-row" key={item.week}><strong>S{item.week}</strong><span>Semaine {item.week} à contacter le {dayFormat.format(item.date)}</span></div>)}</div>
      </Panel>
    </div>
    <details className="recent-details">
      <summary>Dernières modifications (24 h) <span aria-hidden="true">⌄</span></summary>
      <div className="recent-list">{d.recent.length ? d.recent.map(x => <div className="row" key={x.id}><b>{x.action}</b><span>{x.entity_type} · {x.actor_display || '—'} · {formatDate(x.created_at, true)}</span></div>) : <p className="muted">Aucune modification durant les dernières 24 h.</p>}</div>
    </details>
  </>;
}

function Prospection() {
  const [list, setList] = useState<ProspectListItem[]>([]);
  const [all, setAll] = useState<ProspectListItem[]>([]);
  const [filter, setFilter] = useState('');
  const [company, setCompany] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(PROSPECTION_SELECTED_KEY));
  const [importOpen, setImportOpen] = useState(false);
  const [hasImportDraft, setHasImportDraft] = useState(false);
  const [counters, setCounters] = useState<ProspectionCounters>(emptyProspectionCounters);
  // Mémoïsé sur (q, filter, company) : l'effet ci-dessous se relance exactement quand l'un d'eux change, comme avant.
  const load = useCallback(() => Promise.all([
    api<ProspectListItem[]>(`/api/prospects?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&company=${encodeURIComponent(company)}`),
    api<ProspectListItem[]>(`/api/prospects?q=${encodeURIComponent(q)}`),
    api<ProspectionCounters>(`/api/prospection/counters?q=${encodeURIComponent(q)}`)
  ]).then(([filtered, full, counts]) => { setList(filtered); setAll(full); setCounters(counts); }), [q, filter, company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (selected) localStorage.setItem(PROSPECTION_SELECTED_KEY, selected); else localStorage.removeItem(PROSPECTION_SELECTED_KEY); }, [selected]);
  useEffect(() => {
    hasDraft(IMPORT_DRAFT_KEY).then(found => {
      setHasImportDraft(found);
      if (found) setImportOpen(true);
    }).catch(() => undefined);
  }, []);
  const companies = useMemo(() => Array.from(new Map(all.map(x => [x.company_id, x.company])).entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [all]);
  const selectedIndex = selected && selected !== 'new' ? list.findIndex(x => x.id === selected) : -1;
  const prevId = selectedIndex > 0 ? list[selectedIndex - 1]?.id || null : null;
  const nextId = selectedIndex >= 0 ? list[selectedIndex + 1]?.id || null : null;
  return <>
    <div className="top"><PageTitle title="Prospection" sub="Vérifier les coordonnées, la semaine de contact et le suivi de chaque prospect." />
      <div><button className="secondary" onClick={() => setImportOpen(true)}>{hasImportDraft ? 'Reprendre l’import en cours' : 'Importer Excel'}</button><a className="button secondary" href="/api/export.xlsx">Exporter Excel</a><button onClick={() => setSelected('new')}>+ Ajouter un prospect</button></div>
    </div>
    <div className="filters compact-counters">
      {prospectionCards(counters).map(card => <button className={filter === card.filter ? 'active' : ''} aria-pressed={filter === card.filter} title={card.title} onClick={() => setFilter(card.filter)} key={card.label}><span>{card.label}</span><b>{card.count}</b></button>)}
    </div>
    <div className="prospect-toolbar">
      <input className="list-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher une personne, entreprise, fonction, email ou téléphone…" />
      <select value={company} onChange={e => setCompany(e.target.value)}><option value="">Toutes les entreprises</option>{companies.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
    </div>
    <div className="people-scroll"><div className="people">
      {list.map(p => <button key={p.id} onClick={() => setSelected(p.id)}>
        <div className="avatar">{p.first_name?.[0]}{p.last_name?.[0]}</div>
        <div className="identity-cell"><b>{[p.first_name, p.last_name].filter(Boolean).join(' ') || 'Nom non renseigné'}</b><span>Rôle : {p.role || 'Non classé'} · Fonction : {p.exact_job_title || 'Non renseignée'} · {p.company}</span></div>
        <div className="contact-cell"><small>Coordonnées</small><span>{p.primary_email || 'Pas d’email — contacter par téléphone'}</span><em>{p.primary_phone || 'Téléphone manquant'}</em></div>
        <div className="week-cell"><small>Semaine</small><WeekBadge year={p.next_action_year} week={p.next_action_week} />{p.next_action_week == null && <em>Non planifiée</em>}</div>
        <div className="tracking-cell"><small>Suivi</small><StateBadge status={p.tracking_status} /><em>{p.tracking_status === 'appointment_obtained' && p.appointment_at ? `RDV ${formatDate(p.appointment_at, true)}` : p.referent ? `Référent · ${p.referent}` : ''}</em></div>
      </button>)}
      {!list.length && <div className="empty-list">Aucun prospect pour ces filtres.</div>}
    </div></div>
    {selected && <Drawer key={selected} id={selected} prevId={prevId} nextId={nextId} close={() => setSelected(null)} navigate={setSelected} saved={() => { load(); }} trackingChanged={load} />}
    {importOpen && <ImportModal close={() => setImportOpen(false)} done={() => { setHasImportDraft(false); setImportOpen(false); load(); }} draftChanged={setHasImportDraft} />}
  </>;
}

function Drawer({ id, prevId, nextId, close, navigate, saved, trackingChanged }: { id: string; prevId: string | null; nextId: string | null; close: () => void; navigate: (id: string) => void; saved: () => void; trackingChanged: () => void }) {
  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [roles, setRoles] = useState<LabelRow[]>([]);
  const [referents, setReferents] = useState<ReferentRow[]>([]);
  const [form, setForm] = useState<ProspectForm>({ activity_status: 'unknown', contactability_status: 'contactable', tracking: { status: 'neutral' }, emails: [], phones: [] });
  const [original, setOriginal] = useState<SavedProspect>();
  const [tab, setTab] = useState<DrawerTab>('identity');
  const [employmentTouched, setEmploymentTouched] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [error, setError] = useState('');
  const [planningNotice, setPlanningNotice] = useState('');
  const draftKey = `prospect:${id}`;

  useEffect(() => {
    let active = true;
    // Réinitialisation à chaque chargement de fiche (le Drawer est remonté par fiche via `key`, les flèches ←/→ changent `id`) : la
    // faire pendant le rendu changerait la séquence observée par l'effet d'autosauvegarde du brouillon ; conservée telle quelle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraftReady(false);
    setDraftRestored(false);
    setPlanningNotice('');
    Promise.all([
      api<CompanyListItem[]>('/api/companies'),
      api<LabelRow[]>('/api/settings/roles'),
      api<ReferentRow[]>('/api/settings/referents'),
      id !== 'new' ? api<ProspectDetail>('/api/prospects/' + id) : Promise.resolve(null),
      loadDraft<ProspectDraft>(draftKey)
    ]).then(([a, b, c, server, draft]) => {
      if (!active) return;
      setCompanies(a); setRoles(b); setReferents(c);
      if (server) setOriginal(server);
      const base: ProspectForm = server
        ? { ...server.prospect, tracking: server.tracking || { status: 'neutral' }, emails: server.emails || [], phones: server.phones || [], trackingHistory: server.trackingHistory || [], company: server.company }
        : { activity_status: 'unknown', contactability_status: 'contactable', tracking: { status: 'neutral' }, emails: [], phones: [] };
      if (draft?.value?.form) {
        setForm(draft.value.form);
        setTab(draft.value.tab && draft.value.tab !== 'contact' ? draft.value.tab : 'identity');
        setDraftRestored(true);
      } else {
        setForm(base);
        setTab('identity');
      }
      setDraftReady(true);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [id, draftKey]); // draftKey dérive de id seul : mêmes relances qu'avec [id]

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      saveDraft(draftKey, { form, tab }).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draftReady, draftKey, form, tab, employmentTouched]);
  // Retour « PARTIE PROSPECTION » : plus de contrôle de vérification d'emploi dans l'UI ; une modification des champs d'emploi
  // continue d'horodater `employment_verified_at` côté serveur (comportement existant, sans bouton dédié).
  const setEmployment = (patch: Partial<ProspectRow>) => { setEmploymentTouched(true); setForm(f => ({ ...f, ...patch })); };
  const save = async () => {
    setError('');
    try {
      await api(id === 'new' ? '/api/prospects' : '/api/prospects/' + id, {
        method: id === 'new' ? 'POST' : 'PUT',
        // La semaine se planifie uniquement via PATCH tracking (WeekPlanner) : ne jamais la renvoyer, un brouillon ancien la réécrirait.
        body: JSON.stringify({ ...form, tracking: withoutPlannedWeek(form.tracking), mark_employment_verified: employmentTouched })
      });
      await deleteDraft(draftKey).catch(() => undefined);
      saved();
    } catch (e) { setError((e as Error).message); }
  };
  const doNotContact = form.contactability_status === 'do_not_contact';
  const trackingStatus = selectableState(form.tracking?.status, doNotContact);
  const savedStatus = original?.tracking?.status;
  const stateLocked = isProspectState(savedStatus) && isTerminalProspectState(savedStatus); // même règle que le service (Task 04)
  const savedHistory: { to_status: string; changed_at: string }[] = original?.trackingHistory ?? [];
  const savedStateSince = savedHistory.find(h => h.to_status === savedStatus)?.changed_at ?? null;
  // Réponse reçue = choix humain « Réponse reçue » ou « RDV pris » (le RDV se prend via le lien envoyé par mail), ou date déjà enregistrée.
  const responseAt = form.tracking?.response_received_at ?? null;
  const hasResponse = trackingStatus === 'response_received' || trackingStatus === 'appointment_obtained' || Boolean(responseAt);
  // Semaine enregistrée à part (PATCH tracking) : la fiche et son brouillon reprennent la semaine renvoyée pour ne pas la réécrire à l'enregistrement.
  const weekPlanned = (tracking: TrackingForm, notice: string) => {
    const week = { next_action_year: tracking.next_action_year ?? null, next_action_week: tracking.next_action_week ?? null };
    setOriginal(o => ({ ...o, tracking: { ...(o?.tracking || {}), ...tracking } }));
    setForm(f => ({ ...f, tracking: { ...(f.tracking || { status: tracking.status }), ...week } }));
    setPlanningNotice(notice);
    trackingChanged();
  };
  const updateEmail = (i: number, patch: EmailForm) => setForm(f => ({ ...f, emails: f.emails.map((x, j) => j === i ? { ...x, ...patch } : x) }));
  const updatePhone = (i: number, patch: PhoneForm) => setForm(f => ({ ...f, phones: f.phones.map((x, j) => j === i ? { ...x, ...patch } : x) }));
  const hasUsableEmail = form.emails.some(mail => (mail.address || '').trim() && mail.verification_status !== 'invalid');
  return <div className="overlay"><div className="drawer">
    <div className="drawer-head"><div><small>{id === 'new' ? 'Nouveau prospect' : 'Fiche prospect'}</small><h2>{form.first_name || '—'} {form.last_name || ''}</h2>{id !== 'new' && <TrackingBadges status={original?.tracking?.status} year={original?.tracking?.next_action_year} week={original?.tracking?.next_action_week} />}</div><button className="icon" aria-label="Fermer la fiche" title="Fermer" onClick={close}>×</button></div>
    <div className="drawer-tabs">
      <button className={tab === 'identity' ? 'active' : ''} onClick={() => setTab('identity')}>Identité, emploi & coordonnées</button>
      <button className={tab === 'tracking' ? 'active' : ''} onClick={() => setTab('tracking')}>Suivi de contact</button>
      <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Provenance</button>
    </div>
    <div className="drawer-body">
      {draftRestored && <p className="warnbox">Brouillon non enregistré restauré automatiquement.</p>}
      {tab === 'identity' && <>
        <Group title="Identité"><Grid>
          <Field label="Prénom"><input value={form.first_name || ''} onChange={e => setForm({ ...form, first_name: e.target.value })} /></Field>
          <Field label="Nom"><input value={form.last_name || ''} onChange={e => setForm({ ...form, last_name: e.target.value })} /></Field>
          <Field label="Civilité"><select value={form.civility || ''} onChange={e => setForm({ ...form, civility: e.target.value })}><option value="">—</option><option>M.</option><option>Mme</option><option>Mlle</option></select></Field>
        </Grid></Group>
        <Group title="Coordonnées">
          <div className="channel-hint"><b>Canal recommandé</b><span>{hasUsableEmail ? 'E-mail' : 'Téléphone — aucun e-mail exploitable'}</span></div>
          <div className="contact-compact">
            <div className="contact-block"><div className="contact-block-head"><b>E-mails</b><button className="secondary small" onClick={() => setForm(f => ({ ...f, emails: [...f.emails, { address: '', verification_status: 'unverified', is_primary: f.emails.length === 0 }] }))}>+ Ajouter</button></div>
              <div className="aliases">{form.emails.map((mail, i) => <div className="alias-row compact" key={mail.id || i}>
                <input aria-label="Adresse e-mail" value={mail.address || ''} onChange={e => updateEmail(i, { address: e.target.value })} placeholder="nom@entreprise.fr" />
                <select aria-label="Statut de l’e-mail" value={mail.verification_status || 'unverified'} onChange={e => updateEmail(i, { verification_status: e.target.value })}><option value="unverified">À vérifier</option><option value="verified">Vérifié</option><option value="invalid">Invalide</option><option value="unknown">Inconnu</option></select>
                <label><input type="radio" name="primary-email" checked={Boolean(mail.is_primary)} onChange={() => setForm(f => ({ ...f, emails: f.emails.map((x, j) => ({ ...x, is_primary: j === i })) }))} /> Principal</label>
                <button className="icon mini" aria-label="Retirer l’e-mail" onClick={() => setForm(f => ({ ...f, emails: f.emails.filter((_, j) => j !== i) }))}>×</button>
              </div>)}</div>
            </div>
            <div className="contact-block"><div className="contact-block-head"><b>Téléphones</b><button className="secondary small" onClick={() => setForm(f => ({ ...f, phones: [...f.phones, { number: '', type: 'other', verification_status: 'unverified', is_primary: f.phones.length === 0 }] }))}>+ Ajouter</button></div>
              <div className="aliases">{form.phones.map((phone, i) => <div className="alias-row phone compact" key={phone.id || i}>
                <input aria-label="Numéro de téléphone" value={phone.number || ''} onChange={e => updatePhone(i, { number: e.target.value })} placeholder="Numéro" />
                <select aria-label="Type de téléphone" value={phone.type || 'other'} onChange={e => updatePhone(i, { type: e.target.value })}><option value="mobile">Mobile</option><option value="landline">Fixe</option><option value="other">Autre</option></select>
                <label><input type="radio" name="primary-phone" checked={Boolean(phone.is_primary)} onChange={() => setForm(f => ({ ...f, phones: f.phones.map((x, j) => ({ ...x, is_primary: j === i })) }))} /> Principal</label>
                <button className="icon mini" aria-label="Retirer le téléphone" onClick={() => setForm(f => ({ ...f, phones: f.phones.filter((_, j) => j !== i) }))}>×</button>
              </div>)}</div>
            </div>
          </div>
        </Group>
        <Group title="Emploi"><Grid>
          <Field label="Entreprise"><select value={form.company_id || ''} onChange={e => setEmployment({ company_id: e.target.value })}><option value="">Sélectionner…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></Field>
          <Field label="Rôle (catégorie)"><select value={form.role_id || ''} onChange={e => setEmployment({ role_id: e.target.value || null })}><option value="">Non classé</option>{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
          <Field label="Fonction exacte"><input value={form.exact_job_title || ''} onChange={e => setEmployment({ exact_job_title: e.target.value })} /></Field>
          <Field label="Statut d’activité"><select value={form.activity_status} onChange={e => setEmployment({ activity_status: e.target.value })}><option value="active">Actif</option><option value="unknown">Inconnu</option><option value="inactive">Inactif</option></select></Field>
        </Grid></Group>
        {form.company && <Group title="Contexte entreprise"><div className="company-summary"><b>{form.company.display_name}</b><span>{form.company.website_url || form.company.email_domain || 'Contexte entreprise disponible dans la base.'}</span></div></Group>}
        {original?.prospect?.contactability_status === 'do_not_contact' && <p className="danger">À ne plus contacter (blocage durable) : aucun message ne peut être préparé ni envoyé.</p>}
      </>}
      {tab === 'tracking' && <>
        <Group title="Suivi de contact">
          <div className="tracking-compact">
            <Field label="Niveau (état, choix humain)"><select disabled={stateLocked} value={trackingStatus ?? ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, status: e.target.value } })}>
              {trackingStatus === null && <option value="" disabled>{String(form.tracking?.status)} (hors contrat)</option>}
              {prospectStates.map(s => <option value={s} key={s}>{stateOptionLabel(s)}</option>)}
            </select></Field>
            <Field label="Référent Circoe"><select value={form.tracking?.referent_id || ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, referent_id: e.target.value || null } })}><option value="">Non affecté</option>{referents.map(r => <option value={r.id} key={r.id}>{r.first_name} {r.last_name}</option>)}</select></Field>
            <div className="stage-note"><small>Réponse reçue</small><b>{hasResponse ? `Oui${responseAt ? ` · ${formatDate(responseAt, true)}` : ''}` : 'Non'}</b></div>
            <div className="stage-note"><small>Rendez-vous</small><b>{trackingStatus === 'appointment_obtained' ? `Oui${form.tracking?.appointment_at ? ` · prévu le ${formatDate(form.tracking.appointment_at, true)}` : ' · date à renseigner'}` : 'Non'}</b></div>
          </div>
          {stateLocked && <p className="danger">« Ignoré » est définitif : l’état ne peut plus être modifié.</p>}
          {trackingStatus === 'appointment_obtained' && <div className="appointment-line"><strong>RDV : oui</strong><Field label="Prévu le (date et heure)"><input type="datetime-local" value={(form.tracking?.appointment_at || '').slice(0, 16)} onChange={e => setForm({ ...form, tracking: { ...form.tracking, appointment_at: e.target.value || null } })} /></Field></div>}
        </Group>
        <Group title="Semaine">
          {id === 'new'
            ? <p className="muted">La semaine pourra être planifiée une fois la fiche enregistrée.</p>
            : original?.prospect?.id === id ? <WeekPlanner key={id} prospectId={id} tracking={original.tracking} stateSince={savedStateSince} onSaved={weekPlanned} /> : <p className="muted">Chargement…</p>}
          <p className="sr-only" aria-live="polite">{planningNotice}</p>
          {form.tracking?.planned_contact_at && <p className="muted">Ancienne date prévue (legacy, non utilisée) : {formatDate(form.tracking.planned_contact_at)}.</p>}
        </Group>
        {(form.trackingHistory?.length ?? 0) > 0 && <Group title="Historique des états">{form.trackingHistory?.slice(0, 8).map(h => <div className="row" key={h.id}><b>{historyStatusLabel(h.to_status, doNotContact)}</b><span>{formatDate(h.changed_at, true)}</span></div>)}</Group>}
      </>}

      {tab === 'history' && <>
        <Group title="Provenance">{original?.sources?.length ? original.sources.map(s => <div className="row" key={s.id}><b>{s.source_type === 'excel_import' ? 'Import Excel' : s.source_type === 'manual' ? 'Saisie VIPER' : s.source_type}</b><span>{s.source_reference} · {formatDate(s.collected_at, true)}</span></div>) : <p className="muted">Aucune provenance enregistrée.</p>}</Group>
        <Group title="Historique récent">{original?.history?.length ? original.history.slice(0, 12).map(h => <div className="row" key={h.id}><b>{h.action}</b><span>{formatDate(h.created_at, true)}</span></div>) : <p className="muted">Aucun changement enregistré.</p>}</Group>
      </>}
      {error && <p className="danger">{error}</p>}
    </div>
    <footer><div className="prospect-nav"><button className="secondary icon-arrow" aria-label="Prospect précédent" title="Prospect précédent" disabled={!prevId} onClick={() => prevId && navigate(prevId)}>←</button><button className="secondary icon-arrow" aria-label="Prospect suivant" title="Prospect suivant" disabled={!nextId} onClick={() => nextId && navigate(nextId)}>→</button></div><button onClick={save}>Enregistrer</button></footer>
  </div></div>;
}

function ImportModal({ close, done, draftChanged }: { close: () => void; done: () => void; draftChanged: (value: boolean) => void }) {
  const [p, setP] = useState<ImportPreview>();
  const [draftRestored, setDraftRestored] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    loadDraft<ImportPreview>(IMPORT_DRAFT_KEY).then(draft => {
      if (!active || !draft?.value) return;
      setP(draft.value);
      setDraftRestored(true);
      draftChanged(true);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [draftChanged]); // draftChanged = setter useState du parent (identité stable) : effet exécuté une seule fois, comme avant

  const persistImportDraft = async (next: ImportPreview) => {
    setError('');
    try {
      await saveDraft(IMPORT_DRAFT_KEY, next);
      draftChanged(true);
      setP(next);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };

  return <div className="overlay center"><div className="modal">
    <div className="drawer-head"><div><small>Excel → base normalisée</small><h2>Import contrôlé</h2></div><button className="icon" onClick={close}>×</button></div>
    <div className="drawer-body">{draftRestored && <p className="warnbox">Brouillon d’import restauré automatiquement. Tes choix et modifications non validés ont été conservés.</p>}{!p ? <label className="drop">Choisir un fichier XLSX, XLS ou CSV<input type="file" accept=".xlsx,.xls,.csv" onChange={async e => {
      const f = e.target.files?.[0]; if (!f) return; setError('');
      try {
        const preview = await previewWorkbook(f);
        await persistImportDraft(preview);
      } catch (e) {
        setError((e as Error).message);
      }
    }} /></label> : <>
      <div className="import-summary"><b>{p.rows?.length || 0} lignes détectées</b><span>Les valeurs S37, S39 et S40 sont conservées comme semaines d’envoi 2026. Les contacts concernés sont considérés comme vérifiés.</span></div>
      {(p.skippedSheets?.length ?? 0) > 0 && <p className="warnbox">Feuille ignorée explicitement : {p.skippedSheets.join(', ')}</p>}
      <div className="preview"><div className="preview-head"><span /><b>Prospect</b><b>Entreprise</b><b>Vérification</b><b>Contact prévu</b><b>Diagnostic</b></div>{p.rows?.slice(0, 120).map((r, i) => <div key={i}>
        <input type="checkbox" checked={!r.excluded} onChange={async e => {
          const rows = [...p.rows];
          rows[i] = { ...r, excluded: !e.target.checked };
          try { await persistImportDraft({ ...p, rows }); } catch { /* erreur affichée dans la modale */ }
        }} />
        <b>{[r.normalized.first_name, r.normalized.last_name].filter(Boolean).join(' ') || 'Inconnu'}</b><span>{r.normalized.company}</span>
        <span className={r.normalized.verification_state === 'verified' ? 'text-ok' : 'text-warn'}>{r.normalized.verification_state === 'verified' ? 'Vérifié' : 'À vérifier'}</span>
        <span>{r.normalized.contact_week ? <WeekBadge year={r.normalized.contact_year} week={r.normalized.contact_week} /> : r.normalized.planned_contact_at ? formatDate(r.normalized.planned_contact_at) : '—'}</span>
        <small>{r.diagnostics.map(d => d.message).join(' · ') || 'Prêt'}</small>
      </div>)}</div>
    </>}{error && <p className="danger">{error}</p>}</div>
    <footer><button className="secondary" onClick={close}>Fermer</button>{p && <button onClick={async () => { try { await commitWorkbookPreview(p); await deleteDraft(IMPORT_DRAFT_KEY); draftChanged(false); done(); } catch (e) { setError((e as Error).message); } }}>Confirmer l’import</button>}</footer>
  </div></div>;
}

function Database() {
  const [tables, setTables] = useState<{ name: string }[]>([]), [table, setTable] = useState('prospects'), [grid, setGrid] = useState<TableGrid>(), [sql, setSql] = useState('SELECT * FROM prospects LIMIT 25'), [out, setOut] = useState<Record<string, unknown>[]>([]);
  useEffect(() => { api<{ name: string }[]>('/api/database/tables').then(setTables); }, []);
  useEffect(() => { api<TableGrid>('/api/database/table/' + table).then(setGrid); }, [table]);
  return <><PageTitle title="Base de données" sub="Explorateur technique et SQL read-only imposé côté serveur." /><div className="db"><nav>{tables.map(t => <button className={table === t.name ? 'active' : ''} key={t.name} onClick={() => setTable(t.name)}>{t.name}</button>)}</nav><div><h3>{table} · {grid?.count || 0} lignes</h3><div className="tablewrap"><table><thead><tr>{grid?.columns?.map(c => <th key={c.name}>{c.name}<small>{c.type}</small></th>)}</tr></thead><tbody>{grid?.data?.map((r, i) => <tr key={i}>{grid.columns.map(c => <td key={c.name} title={String(r[c.name] ?? '')}>{String(r[c.name] ?? '')}</td>)}</tr>)}</tbody></table></div><div className="sql"><b>SQL read-only</b><textarea value={sql} onChange={e => setSql(e.target.value)} /><button onClick={async () => setOut((await api<{ rows: Record<string, unknown>[] }>('/api/database/sql', { method: 'POST', body: JSON.stringify({ sql }) })).rows)}>Exécuter</button>{out.length > 0 && <pre>{JSON.stringify(out.slice(0, 20), null, 2)}</pre>}</div></div></div></>;
}

function Settings() {
  const [roles, setRoles] = useState<LabelRow[]>([]), [cats, setCats] = useState<LabelRow[]>([]), [segments, setSegments] = useState<LabelRow[]>([]), [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const load = () => Promise.all([api<LabelRow[]>('/api/settings/roles'), api<LabelRow[]>('/api/settings/categories'), api<LabelRow[]>('/api/settings/segments'), api<CompanyListItem[]>('/api/companies')]).then(([a, b, c, d]) => { setRoles(a); setCats(b); setSegments(c); setCompanies(d); });
  useEffect(() => { load(); }, []);
  return <><PageTitle title="Paramètres" sub="Taxonomies et référentiels administrables." /><div className="cols"><SettingsSet title="Rôles" items={roles.map(x => x.label)} add={async label => { await api('/api/settings/roles', { method: 'POST', body: JSON.stringify({ label }) }); load(); }} /><SettingsSet title="Catégories d’activité" items={cats.map(x => x.label)} add={async label => { await api('/api/settings/categories', { method: 'POST', body: JSON.stringify({ label }) }); load(); }} /><SettingsSet title="Segments commerciaux" items={segments.map(x => x.label)} add={async label => { await api('/api/settings/segments', { method: 'POST', body: JSON.stringify({ label }) }); load(); }} /><ToolboxSettings /><Panel title="Entreprises"><div className="tags">{companies.slice(0, 50).map(c => <span key={c.id}>{c.display_name} · {c.prospect_count}</span>)}</div></Panel></div></>;
}

function Panel({ title, children }: { title: string; children?: React.ReactNode }) { return <div className="panel"><h3>{title}</h3>{children}</div>; }
function Group({ title, children }: { title: string; children?: React.ReactNode }) { return <div className="group"><h3>{title}</h3>{children}</div>; }
function Grid({ children }: { children?: React.ReactNode }) { return <div className="grid">{children}</div>; }
function Field({ label, children }: { label: string; children?: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function SettingsSet({ title, items, add }: { title: string; items: string[]; add: (s: string) => void }) { const [v, setV] = useState(''); return <Panel title={title}><div className="tags">{items.map(x => <span key={x}>{x}</span>)}</div><form className="inline" onSubmit={e => { e.preventDefault(); if (v.trim()) { add(v.trim()); setV(''); } }}><input value={v} onChange={e => setV(e.target.value)} placeholder="Ajouter…" /><button>Ajouter</button></form></Panel>; }

export function App() {
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');

  const bootstrap = async () => {
    setState('loading');
    try {
      await requestPersistentBrowserStorage();
      const serverHasState = await hasServerBusinessState();
      if (!serverHasState) await restoreLatestViperState();
      await saveCurrentViperState().catch(() => undefined);
      setState('in');
    } catch {
      setState('in');
    }
  };

  useEffect(() => {
    let active = true;
    api('/api/auth/me')
      .then(async () => { if (active) await bootstrap(); })
      .catch(() => { if (active) setState('out'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (state !== 'in') return;
    const timer = window.setInterval(() => { saveCurrentViperState().catch(() => undefined); }, 15000);
    return () => window.clearInterval(timer);
  }, [state]);

  if (state === 'loading') return <div className="login">Chargement et restauration de votre session VIPER…</div>;
  return state === 'in' ? <Shell /> : <Login onDone={() => { bootstrap(); }} />;
}
