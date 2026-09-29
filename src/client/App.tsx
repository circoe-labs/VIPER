import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { commitWorkbookPreview, previewWorkbook } from './importCache';
import { hasServerBusinessState, requestPersistentBrowserStorage, restoreLatestViperState, saveCurrentViperState } from './stateCache';
import { deleteDraft, hasDraft, loadDraft, saveDraft } from './draftCache';
import { isProspectState, isTerminalProspectState, prospectStates } from '../shared/contactWorkflow';
import { TrackingBadges, WeekBadge } from './TrackingBadges';
import { historyStatusLabel, selectableState, stateOptionLabel } from './trackingDisplay';
import { WeekPlanner } from './WeekPlanner';
import { withoutPlannedWeek } from './weekPlanning';
import { emptyProspectionCounters, employmentCheck, prospectionCards } from './prospectionDisplay';
import type { ProspectionCounters } from '../shared/prospectionDashboard';

type Page = 'home' | 'prospection' | 'exploitation' | 'database' | 'settings';
type Prospect = Record<string, any>;

const nav: [Page, string][] = [
  ['home', 'Accueil'], ['prospection', 'Prospection'], ['exploitation', 'Exploitation'], ['database', 'Base de données'], ['settings', 'Paramètres']
];

const IMPORT_DRAFT_KEY = 'import-preview';

const formatDate = (value?: string | null, withTime = false) => {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
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
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem('viper.ui.page') as Page | null;
    return saved && nav.some(([id]) => id === saved) ? saved : 'home';
  });
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  useEffect(() => { localStorage.setItem('viper.ui.page', page); }, [page]);
  useEffect(() => {
    const t = setTimeout(() => search.trim() ? api<any[]>('/api/search?q=' + encodeURIComponent(search)).then(setResults) : setResults([]), 180);
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
      {page === 'home' && <Home onGo={() => setPage('prospection')} />}
      {page === 'prospection' && <Prospection />}
      {page === 'database' && <Database />}
      {page === 'settings' && <Settings />}
      {page === 'exploitation' && <Exploitation />}
    </section></main>
  </div>;
}

const Title = ({ title, sub }: { title: string; sub: string }) => <div className="title"><small>VIPER / V1</small><h1>{title}</h1><p>{sub}</p></div>;

function Home({ onGo }: { onGo: () => void }) {
  const [d, setD] = useState<any>();
  useEffect(() => { api('/api/dashboard').then(setD); }, []);
  if (!d) return <p>Chargement…</p>;
  const cards = [['Prospects', d.total], ['Contacts dus', d.due], ['Emploi à vérifier', d.employmentUnverified], ['Emails à fiabiliser', d.emailToReview], ['Contactés', d.contacted], ['Réponses', d.responses], ['Rendez-vous', d.appointments]];
  return <><Title title="Vue d’ensemble" sub="Santé de la base et activité de contact issue des données réellement enregistrées." />
    <div className="cards">{cards.map(([l, v]) => <button onClick={onGo} key={l}><span>{l}</span><b>{v}</b></button>)}</div>
    <div className="cols"><Panel title="Objectifs mensuels"><Progress label="Prospects contactés" value={d.contacted} target={100} /><Progress label="Rendez-vous" value={d.appointments} target={10} /></Panel>
      <Panel title="Prochaines actions">{d.nextActions.length ? d.nextActions.map((x: any) => <div className="row" key={x.id}><b>{x.first_name} {x.last_name}</b><span className="next-action">{x.company}<TrackingBadges status={x.status} year={x.next_action_year} week={x.next_action_week} /></span></div>) : <p className="muted">Aucune semaine planifiée.</p>}</Panel></div>
  </>;
}

function Prospection() {
  const [list, setList] = useState<Prospect[]>([]);
  const [all, setAll] = useState<Prospect[]>([]);
  const [filter, setFilter] = useState('');
  const [company, setCompany] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('viper.prospection.selected'));
  const [importOpen, setImportOpen] = useState(false);
  const [hasImportDraft, setHasImportDraft] = useState(false);
  const [counters, setCounters] = useState<ProspectionCounters>(emptyProspectionCounters);
  const load = () => Promise.all([
    api<Prospect[]>(`/api/prospects?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&company=${encodeURIComponent(company)}`),
    api<Prospect[]>(`/api/prospects?q=${encodeURIComponent(q)}`),
    api<ProspectionCounters>(`/api/prospection/counters?q=${encodeURIComponent(q)}`)
  ]).then(([filtered, full, counts]) => { setList(filtered); setAll(full); setCounters(counts); });
  useEffect(() => { load(); }, [q, filter, company]);
  useEffect(() => { if (selected) localStorage.setItem('viper.prospection.selected', selected); else localStorage.removeItem('viper.prospection.selected'); }, [selected]);
  useEffect(() => {
    hasDraft(IMPORT_DRAFT_KEY).then(found => {
      setHasImportDraft(found);
      if (found) setImportOpen(true);
    }).catch(() => undefined);
  }, []);
  const companies = useMemo(() => Array.from(new Map(all.map(x => [x.company_id, x.company])).entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [all]);
  const nextId = selected && selected !== 'new' ? list[list.findIndex(x => x.id === selected) + 1]?.id || null : null;
  return <>
    <div className="top"><Title title="Prospection" sub="Vérifier les données, puis piloter le suivi de contact sans mélanger les deux usages." />
      <div><button className="secondary" onClick={() => setImportOpen(true)}>{hasImportDraft ? 'Reprendre l’import en cours' : 'Importer Excel'}</button><a className="button secondary" href="/api/export.xlsx">Exporter Excel</a><button onClick={() => setSelected('new')}>+ Ajouter un prospect</button></div>
    </div>
    <div className="filters compact-counters">
      {prospectionCards(counters).map(card => <button className={filter === card.filter ? 'active' : ''} aria-pressed={filter === card.filter} title={card.title} onClick={() => setFilter(card.filter)} key={card.label}><span>{card.label}</span><b>{card.count}</b></button>)}
    </div>
    <div className="prospect-toolbar">
      <input className="list-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher une personne, entreprise, fonction ou email…" />
      <select value={company} onChange={e => setCompany(e.target.value)}><option value="">Toutes les entreprises</option>{companies.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
    </div>
    <div className="people-scroll"><div className="people">
      {list.map(p => {
        const employment = employmentCheck(p.employment_verified_at, formatDate);
        return <button key={p.id} onClick={() => setSelected(p.id)}>
          <div className="avatar">{p.first_name?.[0]}{p.last_name?.[0]}</div>
          <div className="identity-cell"><b>{[p.first_name, p.last_name].filter(Boolean).join(' ') || 'Nom non renseigné'}</b><span>Rôle : {p.role || 'Non classé'} · Fonction : {p.exact_job_title || 'Non renseignée'} · {p.company}</span></div>
          <div className={`verification-cell ${employment.tone}`}><small>Emploi</small><span><i />{employment.label}</span><em>{employment.detail}</em></div>
          <div className="email-cell"><small>Email</small><span>{p.primary_email || 'Email manquant'}</span><em>{p.email_verification === 'verified' ? `Vérifié ${formatDate(p.email_verified_at)}` : p.primary_email ? 'Non confirmé' : 'À renseigner'}</em></div>
          <div className="tracking-cell"><small>Suivi</small><TrackingBadges status={p.tracking_status} year={p.next_action_year} week={p.next_action_week} empty={<em>—</em>} /><em>{p.referent ? `Référent · ${p.referent}` : ''}</em></div>
        </button>;
      })}
      {!list.length && <div className="empty-list">Aucun prospect pour ces filtres.</div>}
    </div></div>
    {selected && <Drawer id={selected} nextId={nextId} close={() => setSelected(null)} saved={(goNext) => { const n = goNext ? nextId : null; load(); setSelected(n); }} trackingChanged={load} />}
    {importOpen && <ImportModal close={() => setImportOpen(false)} done={() => { setHasImportDraft(false); setImportOpen(false); load(); }} draftChanged={setHasImportDraft} />}
  </>;
}

function Drawer({ id, nextId, close, saved, trackingChanged }: { id: string; nextId: string | null; close: () => void; saved: (goNext: boolean) => void; trackingChanged: () => void }) {
  const [companies, setCompanies] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [referents, setReferents] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ activity_status: 'unknown', contactability_status: 'contactable', tracking: { status: 'neutral' }, emails: [], phones: [] });
  const [original, setOriginal] = useState<any>();
  const [tab, setTab] = useState<'identity' | 'contact' | 'tracking' | 'history'>('identity');
  const [employmentTouched, setEmploymentTouched] = useState(false);
  const [verifyNow, setVerifyNow] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [error, setError] = useState('');
  const [planningNotice, setPlanningNotice] = useState('');
  const draftKey = `prospect:${id}`;

  useEffect(() => {
    let active = true;
    setDraftReady(false);
    setDraftRestored(false);
    setPlanningNotice('');
    Promise.all([
      api<any[]>('/api/companies'),
      api<any[]>('/api/settings/roles'),
      api<any[]>('/api/settings/referents'),
      id !== 'new' ? api<any>('/api/prospects/' + id) : Promise.resolve(null),
      loadDraft<any>(draftKey)
    ]).then(([a, b, c, server, draft]) => {
      if (!active) return;
      setCompanies(a); setRoles(b); setReferents(c);
      if (server) setOriginal(server);
      const base = server
        ? { ...server.prospect, tracking: server.tracking || { status: 'neutral' }, emails: server.emails || [], phones: server.phones || [], trackingHistory: server.trackingHistory || [], company: server.company }
        : { activity_status: 'unknown', contactability_status: 'contactable', tracking: { status: 'neutral' }, emails: [], phones: [] };
      if (draft?.value?.form) {
        setForm(draft.value.form);
        setTab(draft.value.tab || 'identity');
        setEmploymentTouched(Boolean(draft.value.employmentTouched));
        setVerifyNow(Boolean(draft.value.verifyNow));
        setDraftRestored(true);
      } else {
        setForm(base);
        setTab('identity');
        setEmploymentTouched(false);
        setVerifyNow(false);
      }
      setDraftReady(true);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      saveDraft(draftKey, { form, tab, employmentTouched, verifyNow }).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draftReady, draftKey, form, tab, employmentTouched, verifyNow]);
  const setEmployment = (patch: any) => { setEmploymentTouched(true); setForm((f: any) => ({ ...f, ...patch })); };
  const save = async (goNext = false) => {
    setError('');
    try {
      await api(id === 'new' ? '/api/prospects' : '/api/prospects/' + id, {
        method: id === 'new' ? 'POST' : 'PUT',
        // La semaine se planifie uniquement via PATCH tracking (WeekPlanner) : ne jamais la renvoyer, un brouillon ancien la réécrirait.
        body: JSON.stringify({ ...form, tracking: withoutPlannedWeek(form.tracking), mark_employment_verified: verifyNow || employmentTouched })
      });
      await deleteDraft(draftKey).catch(() => undefined);
      saved(goNext);
    } catch (e) { setError((e as Error).message); }
  };
  const doNotContact = form.contactability_status === 'do_not_contact';
  const trackingStatus = selectableState(form.tracking?.status, doNotContact);
  const savedStatus = original?.tracking?.status;
  const stateLocked = isProspectState(savedStatus) && isTerminalProspectState(savedStatus); // même règle que le service (Task 04)
  const currentHistory = form.trackingHistory?.find((h: any) => h.to_status === form.tracking?.status);
  const savedHistory: { to_status: string; changed_at: string }[] = original?.trackingHistory ?? [];
  const savedStateSince = savedHistory.find(h => h.to_status === savedStatus)?.changed_at ?? null;
  // Semaine enregistrée à part (PATCH tracking) : la fiche et son brouillon reprennent la semaine renvoyée pour ne pas la réécrire à l'enregistrement.
  const weekPlanned = (tracking: Record<string, unknown>, notice: string) => {
    const week = { next_action_year: tracking.next_action_year ?? null, next_action_week: tracking.next_action_week ?? null };
    setOriginal((o: Prospect | undefined) => ({ ...o, tracking: { ...(o?.tracking || {}), ...tracking } }));
    setForm((f: Prospect) => ({ ...f, tracking: { ...(f.tracking || { status: tracking.status }), ...week } }));
    setPlanningNotice(notice);
    trackingChanged();
  };
  const updateEmail = (i: number, patch: any) => setForm((f: any) => ({ ...f, emails: f.emails.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) }));
  const updatePhone = (i: number, patch: any) => setForm((f: any) => ({ ...f, phones: f.phones.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) }));
  return <div className="overlay"><div className="drawer">
    <div className="drawer-head"><div><small>{id === 'new' ? 'Nouveau prospect' : 'Fiche prospect'}</small><h2>{form.first_name || '—'} {form.last_name || ''}</h2>{id !== 'new' && <TrackingBadges status={original?.tracking?.status} year={original?.tracking?.next_action_year} week={original?.tracking?.next_action_week} />}</div><button className="icon" onClick={close}>×</button></div>
    <div className="drawer-tabs">
      <button className={tab === 'identity' ? 'active' : ''} onClick={() => setTab('identity')}>Identité & emploi</button>
      <button className={tab === 'contact' ? 'active' : ''} onClick={() => setTab('contact')}>Coordonnées</button>
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
        <Group title="Emploi"><Grid>
          <Field label="Entreprise"><select value={form.company_id || ''} onChange={e => setEmployment({ company_id: e.target.value })}><option value="">Sélectionner…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></Field>
          <Field label="Rôle (catégorie)"><select value={form.role_id || ''} onChange={e => setEmployment({ role_id: e.target.value || null })}><option value="">Non classé</option>{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
          <Field label="Fonction exacte"><input value={form.exact_job_title || ''} onChange={e => setEmployment({ exact_job_title: e.target.value })} /></Field>
          <Field label="Statut d’activité"><select value={form.activity_status} onChange={e => setEmployment({ activity_status: e.target.value })}><option value="active">Actif</option><option value="unknown">Inconnu</option><option value="inactive">Inactif</option></select></Field>
        </Grid></Group>
        <div className={`verification-panel ${form.employment_verified_at ? 'ok' : 'needs'}`}>
          <div><small>Vérification des informations d’emploi</small><b>{form.employment_verified_at ? `Dernière vérification : ${formatDate(form.employment_verified_at)}` : 'Jamais vérifié'}</b><span>{employmentTouched ? 'Les informations d’emploi ont changé : VIPER enregistrera automatiquement la vérification à aujourd’hui.' : 'La date est gérée automatiquement par VIPER.'}</span></div>
          <button className="secondary" onClick={() => setVerifyNow(true)}>{verifyNow ? 'Sera vérifié à l’enregistrement' : 'Marquer vérifié maintenant'}</button>
        </div>
        {form.company && <Group title="Contexte entreprise"><div className="company-summary"><b>{form.company.display_name}</b><span>{form.company.website_url || form.company.email_domain || 'Contexte entreprise disponible dans la base.'}</span></div></Group>}
      </>}
      {tab === 'contact' && <>
        <Group title="Emails">
          <p className="section-help">La date de vérification d’un email est automatique dès que son statut passe à « Vérifié ».</p>
          <div className="aliases">{form.emails?.map((mail: any, i: number) => <div className="alias-row" key={mail.id || i}>
            <input value={mail.address || ''} onChange={e => updateEmail(i, { address: e.target.value })} placeholder="nom@entreprise.fr" />
            <select value={mail.verification_status || 'unverified'} onChange={e => updateEmail(i, { verification_status: e.target.value })}><option value="unverified">À vérifier</option><option value="verified">Vérifié</option><option value="invalid">Invalide</option><option value="unknown">Inconnu</option></select>
            <label><input type="radio" name="primary-email" checked={Boolean(mail.is_primary)} onChange={() => setForm((f: any) => ({ ...f, emails: f.emails.map((x: any, j: number) => ({ ...x, is_primary: j === i })) }))} /> Principal</label>
            <small>{mail.last_verified_at ? `Vérifié ${formatDate(mail.last_verified_at)}` : mail.origin_type === 'imported' ? 'Import Excel · non confirmé' : 'Non vérifié'}</small>
            <button className="icon mini" onClick={() => setForm((f: any) => ({ ...f, emails: f.emails.filter((_: any, j: number) => j !== i) }))}>×</button>
          </div>)}</div>
          <button className="secondary small" onClick={() => setForm((f: any) => ({ ...f, emails: [...f.emails, { address: '', verification_status: 'unverified', is_primary: f.emails.length === 0 }] }))}>+ Ajouter un email</button>
        </Group>
        <Group title="Téléphones"><div className="aliases">{form.phones?.map((phone: any, i: number) => <div className="alias-row phone" key={phone.id || i}>
          <input value={phone.number || ''} onChange={e => updatePhone(i, { number: e.target.value })} placeholder="Numéro" />
          <select value={phone.type || 'other'} onChange={e => updatePhone(i, { type: e.target.value })}><option value="mobile">Mobile</option><option value="landline">Fixe</option><option value="other">Autre</option></select>
          <select value={phone.verification_status || 'unverified'} onChange={e => updatePhone(i, { verification_status: e.target.value })}><option value="unverified">À vérifier</option><option value="verified">Vérifié</option><option value="invalid">Invalide</option><option value="unknown">Inconnu</option></select>
          <button className="icon mini" onClick={() => setForm((f: any) => ({ ...f, phones: f.phones.filter((_: any, j: number) => j !== i) }))}>×</button>
        </div>)}</div><button className="secondary small" onClick={() => setForm((f: any) => ({ ...f, phones: [...f.phones, { number: '', type: 'other', verification_status: 'unverified', is_primary: f.phones.length === 0 }] }))}>+ Ajouter un téléphone</button></Group>
        <Group title="Contactabilité"><Grid>
          <Field label="État"><select disabled={original?.prospect?.contactability_status === 'do_not_contact'} value={form.contactability_status} onChange={e => setForm({ ...form, contactability_status: e.target.value })}><option value="contactable">Contactable</option><option value="do_not_contact">À ne plus contacter</option></select></Field>
          <Field label="Motif"><input value={form.do_not_contact_reason || ''} onChange={e => setForm({ ...form, do_not_contact_reason: e.target.value })} /></Field>
        </Grid>{original?.prospect?.contactability_status === 'do_not_contact' && <p className="danger">Blocage durable : une simple édition ou un ré-import ne peut pas le lever.</p>}</Group>
      </>}
      {tab === 'tracking' && <>
        <Group title="État actuel"><Grid>
          <Field label="État (choix humain)"><select disabled={stateLocked} value={trackingStatus ?? ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, status: e.target.value } })}>
            {trackingStatus === null && <option value="" disabled>{String(form.tracking?.status)} (hors contrat)</option>}
            {prospectStates.map(s => <option value={s} key={s}>{stateOptionLabel(s)}</option>)}
          </select></Field>
        </Grid>{stateLocked && <p className="danger">« Ignoré » est définitif : l’état ne peut plus être modifié.</p>}</Group>
        <Group title="Planification">
          <p className="section-help">Semaine du prochain contact ou de la prochaine relance, indépendante de l’état : un prospect sans état peut être planifié.</p>
          {id === 'new'
            ? <p className="muted">La semaine pourra être planifiée une fois la fiche enregistrée.</p>
            : original?.prospect?.id === id ? <WeekPlanner key={id} prospectId={id} tracking={original.tracking} stateSince={savedStateSince} onSaved={weekPlanned} /> : <p className="muted">Chargement…</p>}
          <p className="sr-only" aria-live="polite">{planningNotice}</p>
        </Group>
        <div className="stage-context">
          <div className="stage-note"><small>Date de l’étape</small><b>{currentHistory?.changed_at ? formatDate(currentHistory.changed_at, true) : 'Elle sera enregistrée automatiquement lors du changement d’étape.'}</b></div>
          {form.tracking?.planned_contact_at && <div className="stage-note legacy"><small>Ancienne date prévue (legacy, non utilisée)</small><b>{formatDate(form.tracking.planned_contact_at)}</b><span className="muted">Seule la semaine planifiée compte ; la date/heure d’envoi se choisira sur le mail.</span></div>}
          {trackingStatus === 'response_received' && <div className="stage-note"><small>Réponse reçue</small><b>{form.tracking?.response_received_at ? formatDate(form.tracking.response_received_at, true) : 'La date sera enregistrée automatiquement à la sauvegarde.'}</b></div>}
          {trackingStatus === 'appointment_obtained' && <Field label="Date du rendez-vous"><input type="datetime-local" value={(form.tracking?.appointment_at || '').slice(0, 16)} onChange={e => setForm({ ...form, tracking: { ...form.tracking, appointment_at: e.target.value || null } })} /></Field>}
          {trackingStatus === 'appointment_obtained' && <Field label="Référent Circoe"><select value={form.tracking?.referent_id || ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, referent_id: e.target.value || null } })}><option value="">Non affecté</option>{referents.map(r => <option value={r.id} key={r.id}>{r.first_name} {r.last_name}</option>)}</select></Field>}
        </div>
        {form.trackingHistory?.length > 0 && <Group title="Historique des états">{form.trackingHistory.slice(0, 8).map((h: any) => <div className="row" key={h.id}><b>{historyStatusLabel(h.to_status, doNotContact)}</b><span>{formatDate(h.changed_at, true)}</span></div>)}</Group>}
      </>}
      {tab === 'history' && <>
        <Group title="Provenance">{original?.sources?.length ? original.sources.map((s: any) => <div className="row" key={s.id}><b>{s.source_type === 'excel_import' ? 'Import Excel' : s.source_type === 'manual' ? 'Saisie VIPER' : s.source_type}</b><span>{s.source_reference} · {formatDate(s.collected_at, true)}</span></div>) : <p className="muted">Aucune provenance enregistrée.</p>}</Group>
        <Group title="Historique récent">{original?.history?.length ? original.history.slice(0, 12).map((h: any) => <div className="row" key={h.id}><b>{h.action}</b><span>{formatDate(h.created_at, true)}</span></div>) : <p className="muted">Aucun changement enregistré.</p>}</Group>
      </>}
      {error && <p className="danger">{error}</p>}
    </div>
    <footer><button className="secondary" onClick={close}>Fermer</button>{nextId && id !== 'new' && <button className="secondary" onClick={() => save(true)}>Enregistrer et suivant</button>}<button onClick={() => save(false)}>Enregistrer</button></footer>
  </div></div>;
}

function ImportModal({ close, done, draftChanged }: { close: () => void; done: () => void; draftChanged: (value: boolean) => void }) {
  const [p, setP] = useState<any>();
  const [draftRestored, setDraftRestored] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    loadDraft<any>(IMPORT_DRAFT_KEY).then(draft => {
      if (!active || !draft?.value) return;
      setP(draft.value);
      setDraftRestored(true);
      draftChanged(true);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, []);

  const persistImportDraft = async (next: any) => {
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
      {p.skippedSheets?.length > 0 && <p className="warnbox">Feuille ignorée explicitement : {p.skippedSheets.join(', ')}</p>}
      <div className="preview"><div className="preview-head"><span /><b>Prospect</b><b>Entreprise</b><b>Vérification</b><b>Contact prévu</b><b>Diagnostic</b></div>{p.rows?.slice(0, 120).map((r: any, i: number) => <div key={i}>
        <input type="checkbox" checked={!r.excluded} onChange={async e => {
          const rows = [...p.rows];
          rows[i] = { ...r, excluded: !e.target.checked };
          try { await persistImportDraft({ ...p, rows }); } catch { /* erreur affichée dans la modale */ }
        }} />
        <b>{[r.normalized.first_name, r.normalized.last_name].filter(Boolean).join(' ') || 'Inconnu'}</b><span>{r.normalized.company}</span>
        <span className={r.normalized.verification_state === 'verified' ? 'text-ok' : 'text-warn'}>{r.normalized.verification_state === 'verified' ? 'Vérifié' : 'À vérifier'}</span>
        <span>{r.normalized.contact_week ? <WeekBadge year={r.normalized.contact_year} week={r.normalized.contact_week} /> : r.normalized.planned_contact_at ? formatDate(r.normalized.planned_contact_at) : '—'}</span>
        <small>{r.diagnostics.map((d: any) => d.message).join(' · ') || 'Prêt'}</small>
      </div>)}</div>
    </>}{error && <p className="danger">{error}</p>}</div>
    <footer><button className="secondary" onClick={close}>Fermer</button>{p && <button onClick={async () => { try { await commitWorkbookPreview(p); await deleteDraft(IMPORT_DRAFT_KEY); draftChanged(false); done(); } catch (e) { setError((e as Error).message); } }}>Confirmer l’import</button>}</footer>
  </div></div>;
}

function Database() {
  const [tables, setTables] = useState<any[]>([]), [table, setTable] = useState('prospects'), [grid, setGrid] = useState<any>(), [sql, setSql] = useState('SELECT * FROM prospects LIMIT 25'), [out, setOut] = useState<any[]>([]);
  useEffect(() => { api<any[]>('/api/database/tables').then(setTables); }, []);
  useEffect(() => { api('/api/database/table/' + table).then(setGrid); }, [table]);
  return <><Title title="Base de données" sub="Explorateur technique et SQL read-only imposé côté serveur." /><div className="db"><nav>{tables.map(t => <button className={table === t.name ? 'active' : ''} key={t.name} onClick={() => setTable(t.name)}>{t.name}</button>)}</nav><div><h3>{table} · {grid?.count || 0} lignes</h3><div className="tablewrap"><table><thead><tr>{grid?.columns?.map((c: any) => <th key={c.name}>{c.name}<small>{c.type}</small></th>)}</tr></thead><tbody>{grid?.data?.map((r: any, i: number) => <tr key={i}>{grid.columns.map((c: any) => <td key={c.name} title={String(r[c.name] ?? '')}>{String(r[c.name] ?? '')}</td>)}</tr>)}</tbody></table></div><div className="sql"><b>SQL read-only</b><textarea value={sql} onChange={e => setSql(e.target.value)} /><button onClick={async () => setOut((await api<any>('/api/database/sql', { method: 'POST', body: JSON.stringify({ sql }) })).rows)}>Exécuter</button>{out.length > 0 && <pre>{JSON.stringify(out.slice(0, 20), null, 2)}</pre>}</div></div></div></>;
}

function Settings() {
  const [roles, setRoles] = useState<any[]>([]), [cats, setCats] = useState<any[]>([]), [segments, setSegments] = useState<any[]>([]), [companies, setCompanies] = useState<any[]>([]);
  const load = () => Promise.all([api<any[]>('/api/settings/roles'), api<any[]>('/api/settings/categories'), api<any[]>('/api/settings/segments'), api<any[]>('/api/companies')]).then(([a, b, c, d]) => { setRoles(a); setCats(b); setSegments(c); setCompanies(d); });
  useEffect(() => { load(); }, []);
  return <><Title title="Paramètres" sub="Taxonomies et référentiels administrables." /><div className="cols"><SettingsSet title="Rôles" items={roles.map(x => x.label)} add={async label => { await api('/api/settings/roles', { method: 'POST', body: JSON.stringify({ label }) }); load(); }} /><SettingsSet title="Catégories d’activité" items={cats.map(x => x.label)} add={async label => { await api('/api/settings/categories', { method: 'POST', body: JSON.stringify({ label }) }); load(); }} /><SettingsSet title="Segments commerciaux" items={segments.map(x => x.label)} add={async label => { await api('/api/settings/segments', { method: 'POST', body: JSON.stringify({ label }) }); load(); }} /><Panel title="Entreprises"><div className="tags">{companies.slice(0, 50).map(c => <span key={c.id}>{c.display_name} · {c.prospect_count}</span>)}</div></Panel></div></>;
}

function Exploitation() { return <div className="coming"><img src="/viper-mark.svg" /><small>VIPER / V1</small><h1>Exploitation</h1><p>Cette surface est volontairement réservée. Aucun brouillon, agent, envoi ou métrique fictive n’est simulé en V1.</p><b>Coming soon</b></div>; }
function Panel({ title, children }: any) { return <div className="panel"><h3>{title}</h3>{children}</div>; }
function Progress({ label, value, target }: any) { return <div className="progress"><div><span>{label}</span><b>{value} / {target}</b></div><i><em style={{ width: `${Math.min(100, value / target * 100)}%` }} /></i></div>; }
function Group({ title, children }: any) { return <div className="group"><h3>{title}</h3>{children}</div>; }
function Grid({ children }: any) { return <div className="grid">{children}</div>; }
function Field({ label, children }: any) { return <label className="field"><span>{label}</span>{children}</label>; }
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
