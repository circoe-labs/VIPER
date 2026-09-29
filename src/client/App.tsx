import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { commitWorkbookPreview, previewWorkbook } from './importCache';
import { hasServerBusinessState, requestPersistentBrowserStorage, restoreLatestViperState, saveCurrentViperState } from './stateCache';
import { deleteDraft, hasDraft, loadDraft, saveDraft } from './draftCache';

type Page = 'home' | 'prospection' | 'exploitation' | 'database' | 'settings';
type Prospect = Record<string, any>;

const nav: [Page, string][] = [
  ['home', 'Accueil'], ['prospection', 'Prospection'], ['exploitation', 'Exploitation'], ['database', 'Base de données'], ['settings', 'Paramètres']
];

const trackingLabels: Record<string, string> = {
  to_contact: 'À contacter',
  contacted: 'Contacté',
  follow_up_1: 'Relance 1',
  follow_up_2: 'Relance 2',
  follow_up_3: 'Relance 3',
  follow_up_4: 'Relance 4',
  follow_up_5: 'Relance 5',
  defaillant: 'Défaillant',
  response_received: 'Réponse reçue',
  appointment_obtained: 'Rendez-vous obtenu',
  quote_sent: 'Devis envoyé',
  quote_follow_up: 'Devis relancé',
  won: 'Commande passée',
  not_interested: 'Non intéressé'
};
const trackingStatuses = Object.keys(trackingLabels);
const stageAfterAppointment = new Set(['appointment_obtained', 'quote_sent', 'quote_follow_up', 'won']);
const stagesWithNextAction = new Set(['to_contact', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'follow_up_4', 'follow_up_5']);
const IMPORT_DRAFT_KEY = 'import-preview';

const formatDate = (value?: string | null, withTime = false) => {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
};

function followUpValue(status?: string | null) {
  const match = String(status || '').match(/^follow_up_([1-5])$/);
  if (match) return match[1];
  if (status === 'defaillant') return 'defaillant';
  return '0';
}

function followUpLabel(status?: string | null) {
  const value = followUpValue(status);
  if (value === 'defaillant') return 'Défaillant';
  return value === '0' ? 'Aucune relance' : `Relance ${value}`;
}

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

  const trendDelta = Number(d.responseTrend?.current || 0) - Number(d.responseTrend?.previous || 0);
  const trendTone = trendDelta > 0 ? 'up' : trendDelta < 0 ? 'down' : 'flat';
  const trendArrow = trendDelta > 0 ? '↗' : trendDelta < 0 ? '↘' : '→';

  const month = d.month || { sansReponse: 0, reponses: 0, rdv: 0, devis: 0 };
  const pieValues = [month.sansReponse || 0, month.reponses || 0, month.rdv || 0, month.devis || 0];
  const pieTotal = Math.max(1, pieValues.reduce((a: number, b: number) => a + b, 0));
  const p1 = pieValues[0] / pieTotal * 100;
  const p2 = p1 + pieValues[1] / pieTotal * 100;
  const p3 = p2 + pieValues[2] / pieTotal * 100;
  const pieBackground = `conic-gradient(#66736e 0 ${p1}%, #46d98a ${p1}% ${p2}%, #56a8ff ${p2}% ${p3}%, #d7b45a ${p3}% 100%)`;

  const now = new Date();
  const monday = new Date(now);
  const offset = (now.getDay() + 6) % 7;
  monday.setDate(now.getDate() - offset);
  monday.setHours(12, 0, 0, 0);
  const schedule = [[37, 0, 'Lundi'], [39, 1, 'Mardi'], [40, 2, 'Mercredi'], [41, 3, 'Jeudi']].map(([week, day, label]: any) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + day);
    return { week, label, date: date.toISOString() };
  });

  const baseCards = [
    ['Prospects', d.total],
    ['RDV confirmés', d.appointments],
    ['Défaillants', d.defaillants],
    ['À vérifier', d.incompleteContacts]
  ];
  const activityCards = [
    ['À contacter', d.toContact],
    ['Sans réponses', d.withoutResponses],
    ['RDV', d.appointments],
    ['Devis envoyés', d.quotesSent]
  ];

  return <><Title title="Vue d’ensemble" sub="Pilotage synthétique de la base et de l’activité de contact." />
    <div className="section-label">BASE</div>
    <div className="base-grid">
      {baseCards.map(([label, value]) => <button className="metric-card" onClick={onGo} key={label}><span>{label}</span><b>{value}</b></button>)}
      <div className={`trend-card ${trendTone}`}>
        <span>Réponses vs semaine passée</span>
        <div><b>{trendArrow}</b><strong>{trendDelta > 0 ? '+' : ''}{trendDelta}</strong></div>
        <small>{d.responseTrend?.current || 0} cette semaine · {d.responseTrend?.previous || 0} la semaine passée</small>
      </div>
    </div>

    <div className="section-label home-section-gap">Activité de contact</div>
    <div className="activity-grid">{activityCards.map(([label, value]) => <button className="metric-card" onClick={onGo} key={label}><span>{label}</span><b>{value}</b></button>)}</div>

    <div className="home-grid">
      <Panel title="Progression du mois">
        <div className="pie-wrap">
          <div className="pie-chart" style={{ background: pieBackground }}><span>{pieValues.reduce((a: number, b: number) => a + b, 0)}</span></div>
          <div className="pie-legend">
            <span><i className="legend-dot neutral" />Sans réponse <b>{month.sansReponse || 0}</b></span>
            <span><i className="legend-dot green" />Réponses <b>{month.reponses || 0}</b></span>
            <span><i className="legend-dot blue" />RDV <b>{month.rdv || 0}</b></span>
            <span><i className="legend-dot gold" />Devis <b>{month.devis || 0}</b></span>
          </div>
        </div>
      </Panel>
      <Panel title="Planning de contact">
        <div className="week-schedule">{schedule.map(item => <div className="week-schedule-row" key={item.week}><strong>S{item.week}</strong><span>{item.label} · {formatDate(item.date)}</span></div>)}</div>
      </Panel>
    </div>

    <details className="recent-details">
      <summary>Dernières modifications des dernières 24 h <span>⌄</span></summary>
      <div className="recent-list">{d.recent?.length ? d.recent.map((x: any) => <div className="row" key={x.id}><b>{x.action}</b><span>{x.entity_type} · {formatDate(x.created_at, true)}</span></div>) : <p className="muted">Aucune modification durant les dernières 24 h.</p>}</div>
    </details>
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
  const load = () => Promise.all([
    api<Prospect[]>(`/api/prospects?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&company=${encodeURIComponent(company)}`),
    api<Prospect[]>(`/api/prospects?q=${encodeURIComponent(q)}`)
  ]).then(([filtered, full]) => { setList(filtered); setAll(full); });
  useEffect(() => { load(); }, [q, filter, company]);
  useEffect(() => { if (selected) localStorage.setItem('viper.prospection.selected', selected); else localStorage.removeItem('viper.prospection.selected'); }, [selected]);
  useEffect(() => {
    hasDraft(IMPORT_DRAFT_KEY).then(found => {
      setHasImportDraft(found);
      if (found) setImportOpen(true);
    }).catch(() => undefined);
  }, []);

  const outreachStatuses = new Set(['to_contact', 'contacted', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'follow_up_4', 'follow_up_5']);
  const c = useMemo(() => ({
    all: all.length,
    incomplete: all.filter(x => !x.primary_email || !x.primary_phone).length,
    toContact: all.filter(x => outreachStatuses.has(x.tracking_status)).length,
    noResponse: all.filter(x => outreachStatuses.has(x.tracking_status) && !x.response_received_at).length,
    rdv: all.filter(x => x.appointment_at).length,
    defaillants: all.filter(x => x.tracking_status === 'defaillant').length
  }), [all]);
  const companies = useMemo(() => Array.from(new Map(all.map(x => [x.company_id, x.company])).entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [all]);
  const selectedIndex = selected && selected !== 'new' ? list.findIndex(x => x.id === selected) : -1;
  const prevId = selectedIndex > 0 ? list[selectedIndex - 1]?.id || null : null;
  const nextId = selectedIndex >= 0 ? list[selectedIndex + 1]?.id || null : null;
  const quick = [
    ['Coordonnées incomplètes', 'incomplete_contact'],
    ['S37', 'week:37'], ['S39', 'week:39'], ['S40', 'week:40'], ['S41', 'week:41'],
    ['Sans réponse', 'no_response'], ['RDV', 'appointments'], ['Défaillants', 'defaillant']
  ];

  return <>
    <div className="top"><Title title="Prospection" sub="Piloter les contacts, leur semaine d’appartenance et le suivi des relances." />
      <div><button className="secondary" onClick={() => setImportOpen(true)}>{hasImportDraft ? 'Reprendre l’import en cours' : 'Importer Excel'}</button><a className="button secondary" href="/api/export.xlsx">Exporter Excel</a><button onClick={() => setSelected('new')}>+ Ajouter un prospect</button></div>
    </div>
    <div className="filters compact-counters">
      {[
        ['Tous', c.all, ''], ['À vérifier', c.incomplete, 'incomplete_contact'], ['À contacter', c.toContact, 'outreach'], ['Sans réponse', c.noResponse, 'no_response'], ['Rendez-vous', c.rdv, 'appointments'], ['Défaillants', c.defaillants, 'defaillant']
      ].map(([l, n, f]: any) => <button className={filter === f ? 'active' : ''} onClick={() => setFilter(f)} key={l}><span>{l}</span><b>{n}</b></button>)}
    </div>
    <div className="prospect-toolbar">
      <input className="list-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher une personne, entreprise, fonction, email ou téléphone…" />
      <div className="quick-filters">{quick.map(([label, value]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(filter === value ? '' : value)}>{label}</button>)}</div>
      <select value={company} onChange={e => setCompany(e.target.value)}><option value="">Toutes les entreprises</option>{companies.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
    </div>
    <div className="people-scroll"><div className="people">
      {list.map(p => <button key={p.id} onClick={() => setSelected(p.id)}>
        <div className="avatar">{p.first_name?.[0]}{p.last_name?.[0]}</div>
        <div className="identity-cell"><b>{[p.first_name, p.last_name].filter(Boolean).join(' ') || 'Inconnu'}</b><span>Rôle : {p.role || 'Non classé'} · Fonction : {p.exact_job_title || 'Inconnue'} · {p.company}</span></div>
        <div className="contact-cell"><small>Coordonnées</small><span>{p.primary_email || 'Pas d’email — contacter par téléphone'}</span><em>{p.primary_phone || 'Téléphone manquant'}</em></div>
        <div className="week-cell"><small>Semaine</small><strong>{p.contact_week ? `S${p.contact_week}` : 'S—'}</strong><em>{p.contact_week ? 'Groupe de contact' : 'À attribuer'}</em></div>
        <div className="tracking-cell"><small>Suivi</small><strong>{p.appointment_at ? 'RDV confirmé' : followUpLabel(p.tracking_status)}</strong><em>{p.appointment_at ? formatDate(p.appointment_at, true) : p.referent ? `Référent · ${p.referent}` : trackingLabels[p.tracking_status] || 'À contacter'}</em></div>
      </button>)}
      {!list.length && <div className="empty-list">Aucun prospect pour ces filtres.</div>}
    </div></div>
    {selected && <Drawer id={selected} prevId={prevId} nextId={nextId} close={() => setSelected(null)} navigate={setSelected} saved={() => { load(); }} />}
    {importOpen && <ImportModal close={() => setImportOpen(false)} done={() => { setHasImportDraft(false); setImportOpen(false); load(); }} draftChanged={setHasImportDraft} />}
  </>;
}

function Drawer({ id, prevId, nextId, close, navigate, saved }: { id: string; prevId: string | null; nextId: string | null; close: () => void; navigate: (id: string) => void; saved: () => void }) {
  const [companies, setCompanies] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [referents, setReferents] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ activity_status: 'unknown', tracking: { status: 'to_contact', contact_week: null, contact_year: 2026 }, emails: [], phones: [] });
  const [original, setOriginal] = useState<any>();
  const [tab, setTab] = useState<'identity' | 'tracking' | 'history'>('identity');
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [error, setError] = useState('');
  const draftKey = `prospect:${id}`;

  useEffect(() => {
    let active = true;
    setDraftReady(false);
    setDraftRestored(false);
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
        ? { ...server.prospect, tracking: server.tracking || { status: 'to_contact', contact_week: null, contact_year: 2026 }, emails: server.emails || [], phones: server.phones || [], trackingHistory: server.trackingHistory || [], company: server.company }
        : { activity_status: 'unknown', tracking: { status: 'to_contact', contact_week: null, contact_year: 2026 }, emails: [], phones: [] };
      if (draft?.value?.form) {
        setForm(draft.value.form);
        setTab(draft.value.tab || 'identity');
        setDraftRestored(true);
      } else {
        setForm(base);
        setTab('identity');
      }
      setDraftReady(true);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      saveDraft(draftKey, { form, tab }).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draftReady, draftKey, form, tab]);

  const save = async () => {
    setError('');
    try {
      await api(id === 'new' ? '/api/prospects' : '/api/prospects/' + id, {
        method: id === 'new' ? 'POST' : 'PUT',
        body: JSON.stringify({ ...form, mark_employment_verified: true })
      });
      await deleteDraft(draftKey).catch(() => undefined);
      saved();
    } catch (e) { setError((e as Error).message); }
  };

  const trackingStatus = form.tracking?.status || 'to_contact';
  const relance = followUpValue(trackingStatus);
  const hasResponse = Boolean(form.tracking?.response_received_at || form.tracking?.response_received || form.tracking?.appointment_at);
  const updateEmail = (i: number, patch: any) => setForm((f: any) => ({ ...f, emails: f.emails.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) }));
  const updatePhone = (i: number, patch: any) => setForm((f: any) => ({ ...f, phones: f.phones.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) }));
  const setRelance = (value: string) => {
    const status = value === 'defaillant' ? 'defaillant' : value === '0' ? 'to_contact' : `follow_up_${value}`;
    setForm((f: any) => ({ ...f, tracking: { ...f.tracking, status } }));
  };
  const setResponse = (yes: boolean) => {
    setForm((f: any) => ({
      ...f,
      tracking: {
        ...f.tracking,
        response_received: yes,
        response_received_at: yes ? f.tracking?.response_received_at : null,
        appointment_at: yes ? f.tracking?.appointment_at : null,
        status: yes ? (stageAfterAppointment.has(f.tracking?.status) ? f.tracking.status : 'appointment_obtained') : (followUpValue(f.tracking?.status) === 'defaillant' ? 'defaillant' : followUpValue(f.tracking?.status) === '0' ? 'to_contact' : f.tracking.status)
      }
    }));
  };

  return <div className="overlay"><div className="drawer">
    <div className="drawer-head"><div><small>{id === 'new' ? 'Nouveau prospect' : 'Fiche prospect'}</small><h2>{form.first_name || '—'} {form.last_name || ''}</h2></div><button className="icon" onClick={close}>×</button></div>
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
          <div className="channel-hint"><b>Canal recommandé</b><span>{form.emails?.some((mail: any) => mail.address && mail.verification_status !== 'invalid') ? 'E-mail' : 'Téléphone — aucun e-mail exploitable'}</span></div>
          <div className="contact-compact">
            <div className="contact-block"><div className="contact-block-head"><b>E-mails</b><button className="secondary small" onClick={() => setForm((f: any) => ({ ...f, emails: [...f.emails, { address: '', verification_status: 'unverified', is_primary: f.emails.length === 0 }] }))}>+ Ajouter</button></div>
              <div className="aliases">{form.emails?.map((mail: any, i: number) => <div className="alias-row compact" key={mail.id || i}>
                <input value={mail.address || ''} onChange={e => updateEmail(i, { address: e.target.value })} placeholder="nom@entreprise.fr" />
                <select value={mail.verification_status || 'unverified'} onChange={e => updateEmail(i, { verification_status: e.target.value })}><option value="unverified">À confirmer</option><option value="verified">Valide</option><option value="invalid">Invalide</option><option value="unknown">Inconnu</option></select>
                <label><input type="radio" name="primary-email" checked={Boolean(mail.is_primary)} onChange={() => setForm((f: any) => ({ ...f, emails: f.emails.map((x: any, j: number) => ({ ...x, is_primary: j === i })) }))} /> Principal</label>
                <button className="icon mini" onClick={() => setForm((f: any) => ({ ...f, emails: f.emails.filter((_: any, j: number) => j !== i) }))}>×</button>
              </div>)}</div>
            </div>
            <div className="contact-block"><div className="contact-block-head"><b>Téléphones</b><button className="secondary small" onClick={() => setForm((f: any) => ({ ...f, phones: [...f.phones, { number: '', type: 'other', verification_status: 'unverified', is_primary: f.phones.length === 0 }] }))}>+ Ajouter</button></div>
              <div className="aliases">{form.phones?.map((phone: any, i: number) => <div className="alias-row phone compact" key={phone.id || i}>
                <input value={phone.number || ''} onChange={e => updatePhone(i, { number: e.target.value })} placeholder="Numéro" />
                <select value={phone.type || 'other'} onChange={e => updatePhone(i, { type: e.target.value })}><option value="mobile">Mobile</option><option value="landline">Fixe</option><option value="other">Autre</option></select>
                <label><input type="radio" name="primary-phone" checked={Boolean(phone.is_primary)} onChange={() => setForm((f: any) => ({ ...f, phones: f.phones.map((x: any, j: number) => ({ ...x, is_primary: j === i })) }))} /> Principal</label>
                <button className="icon mini" onClick={() => setForm((f: any) => ({ ...f, phones: f.phones.filter((_: any, j: number) => j !== i) }))}>×</button>
              </div>)}</div>
            </div>
          </div>
        </Group>

        <Group title="Emploi"><Grid>
          <Field label="Entreprise"><select value={form.company_id || ''} onChange={e => setForm({ ...form, company_id: e.target.value })}><option value="">Sélectionner…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></Field>
          <Field label="Rôle (catégorie)"><select value={form.role_id || ''} onChange={e => setForm({ ...form, role_id: e.target.value || null })}><option value="">Non classé</option>{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
          <Field label="Fonction exacte"><input value={form.exact_job_title || ''} onChange={e => setForm({ ...form, exact_job_title: e.target.value })} /></Field>
          <Field label="Statut d’activité"><select value={form.activity_status} onChange={e => setForm({ ...form, activity_status: e.target.value })}><option value="active">Actif</option><option value="unknown">Inconnu</option><option value="inactive">Inactif</option></select></Field>
        </Grid></Group>
        {form.company && <Group title="Contexte entreprise"><div className="company-summary"><b>{form.company.display_name}</b><span>{form.company.website_url || form.company.email_domain || 'Contexte entreprise disponible dans la base.'}</span></div></Group>}
      </>}

      {tab === 'tracking' && <>
        <Group title="Suivi de contact">
          <div className="tracking-compact">
            <Field label="Semaine d’appartenance"><select value={form.tracking?.contact_week || ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, contact_week: e.target.value ? Number(e.target.value) : null, contact_year: 2026 } })}><option value="">À attribuer</option><option value="37">S37</option><option value="39">S39</option><option value="40">S40</option><option value="41">S41</option></select></Field>
            <Field label="Niveau de relance"><select value={relance} onChange={e => setRelance(e.target.value)}><option value="0">Aucune relance</option><option value="1">Relance 1</option><option value="2">Relance 2</option><option value="3">Relance 3</option><option value="4">Relance 4</option><option value="5">Relance 5</option><option value="defaillant">Défaillant — ne plus relancer</option></select></Field>
            <Field label="Référent Circoe"><select value={form.tracking?.referent_id || ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, referent_id: e.target.value || null } })}><option value="">Non affecté</option>{referents.map(r => <option value={r.id} key={r.id}>{r.first_name} {r.last_name}</option>)}</select></Field>
            <Field label="Réponse reçue"><select value={hasResponse ? 'yes' : 'no'} onChange={e => setResponse(e.target.value === 'yes')}><option value="no">Non</option><option value="yes">Oui</option></select></Field>
          </div>
          {hasResponse && <div className="appointment-line"><strong>RDV : oui</strong><Field label="Prévu le"><input type="datetime-local" value={(form.tracking?.appointment_at || '').slice(0, 16)} onChange={e => setForm({ ...form, tracking: { ...form.tracking, appointment_at: e.target.value || null, response_received: true, status: form.tracking?.status === 'quote_sent' || form.tracking?.status === 'quote_follow_up' || form.tracking?.status === 'won' ? form.tracking.status : 'appointment_obtained' } })} /></Field></div>}
          {hasResponse && <Field label="Après le RDV"><select value={['quote_sent', 'quote_follow_up', 'won'].includes(trackingStatus) ? trackingStatus : 'appointment_obtained'} onChange={e => setForm({ ...form, tracking: { ...form.tracking, status: e.target.value } })}><option value="appointment_obtained">RDV confirmé</option><option value="quote_sent">Devis envoyé</option><option value="quote_follow_up">Devis relancé</option><option value="won">Commande passée</option></select></Field>}
        </Group>
        {form.trackingHistory?.length > 0 && <Group title="Historique des étapes">{form.trackingHistory.slice(0, 8).map((h: any) => <div className="row" key={h.id}><b>{trackingLabels[h.to_status] || h.to_status}</b><span>{formatDate(h.changed_at, true)}</span></div>)}</Group>}
      </>}

      {tab === 'history' && <>
        <Group title="Provenance">{original?.sources?.length ? original.sources.map((s: any) => <div className="row" key={s.id}><b>{s.source_type === 'excel_import' ? 'Import Excel' : s.source_type === 'manual' ? 'Saisie VIPER' : s.source_type}</b><span>{s.source_reference} · {formatDate(s.collected_at, true)}</span></div>) : <p className="muted">Aucune provenance enregistrée.</p>}</Group>
        <Group title="Historique récent">{original?.history?.length ? original.history.slice(0, 12).map((h: any) => <div className="row" key={h.id}><b>{h.action}</b><span>{formatDate(h.created_at, true)}</span></div>) : <p className="muted">Aucun changement enregistré.</p>}</Group>
      </>}
      {error && <p className="danger">{error}</p>}
    </div>
    <footer><div className="prospect-nav"><button className="secondary icon-arrow" disabled={!prevId} onClick={() => prevId && navigate(prevId)}>←</button><button className="secondary icon-arrow" disabled={!nextId} onClick={() => nextId && navigate(nextId)}>→</button></div><button onClick={save}>Enregistrer</button></footer>
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
        <span>{r.normalized.contact_week ? `Semaine ${r.normalized.contact_week} · ${r.normalized.contact_year || 2026}` : r.normalized.planned_contact_at ? formatDate(r.normalized.planned_contact_at) : '—'}</span>
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
