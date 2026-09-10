import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api';

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
  response_received: 'Réponse reçue',
  appointment_obtained: 'Rendez-vous obtenu',
  quote_sent: 'Devis envoyé',
  quote_follow_up: 'Devis relancé',
  won: 'Commande passée',
  not_interested: 'Non intéressé'
};
const trackingStatuses = Object.keys(trackingLabels);
const stageAfterAppointment = new Set(['appointment_obtained', 'quote_sent', 'quote_follow_up', 'won']);
const stagesWithNextAction = new Set(['to_contact', 'follow_up_1', 'follow_up_2']);

const formatDate = (value?: string | null, withTime = false) => {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
};

function verificationSummary(p: Prospect) {
  if (!p.employment_verified_at) return { tone: 'never', label: 'Non vérifié', detail: 'À vérifier' };
  if (!p.primary_email || p.email_verification !== 'verified') return { tone: 'partial', label: 'Incomplet', detail: `Emploi vérifié ${formatDate(p.employment_verified_at)}` };
  return { tone: 'verified', label: 'Vérifié', detail: formatDate(p.employment_verified_at) };
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
  const [page, setPage] = useState<Page>('home');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
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
  const cards = [['Prospects', d.total], ['À vérifier', d.neverVerified], ['Contacts dus', d.due], ['Contactés', d.contacted], ['Réponses', d.responses], ['Rendez-vous', d.appointments], ['Emails à fiabiliser', d.emailIssues]];
  return <><Title title="Vue d’ensemble" sub="Santé de la base et activité de contact issue des données réellement enregistrées." />
    <div className="cards">{cards.map(([l, v]) => <button onClick={onGo} key={l}><span>{l}</span><b>{v}</b></button>)}</div>
    <div className="cols"><Panel title="Objectifs mensuels"><Progress label="Prospects contactés" value={d.contacted} target={100} /><Progress label="Rendez-vous" value={d.appointments} target={10} /></Panel>
      <Panel title="Prochaines actions">{d.nextActions.length ? d.nextActions.map((x: any) => <div className="row" key={x.id}><b>{x.first_name} {x.last_name}</b><span>{x.company} · {formatDate(x.planned_contact_at)}</span></div>) : <p className="muted">Aucune action planifiée.</p>}</Panel></div>
  </>;
}

function Prospection() {
  const [list, setList] = useState<Prospect[]>([]);
  const [all, setAll] = useState<Prospect[]>([]);
  const [filter, setFilter] = useState('');
  const [company, setCompany] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const load = () => Promise.all([
    api<Prospect[]>(`/api/prospects?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&company=${encodeURIComponent(company)}`),
    api<Prospect[]>(`/api/prospects?q=${encodeURIComponent(q)}`)
  ]).then(([filtered, full]) => { setList(filtered); setAll(full); });
  useEffect(() => { load(); }, [q, filter, company]);
  const c = useMemo(() => ({
    all: all.length,
    never: all.filter(x => !x.employment_verified_at).length,
    verified: all.filter(x => x.employment_verified_at && x.primary_email && x.email_verification === 'verified').length,
    partial: all.filter(x => x.employment_verified_at && (!x.primary_email || x.email_verification !== 'verified')).length,
    due: all.filter(x => x.tracking_status === 'to_contact' && x.planned_contact_at && x.planned_contact_at <= new Date().toISOString().slice(0, 10)).length,
    contacted: all.filter(x => ['contacted', 'follow_up_1', 'follow_up_2'].includes(x.tracking_status)).length,
    responses: all.filter(x => x.response_received_at).length,
    rdv: all.filter(x => x.appointment_at).length
  }), [all]);
  const companies = useMemo(() => Array.from(new Map(all.map(x => [x.company_id, x.company])).entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [all]);
  const nextId = selected && selected !== 'new' ? list[list.findIndex(x => x.id === selected) + 1]?.id || null : null;
  const quick = [
    ['Vérifiés', 'verified'], ['À vérifier', 'never_verified'], ['Incomplets', 'partial_verification'], ['À contacter', 'status:to_contact'], ['Contactés', 'contacted'], ['Réponses', 'responses'], ['RDV', 'appointments']
  ];
  return <>
    <div className="top"><Title title="Prospection" sub="Vérifier les données, puis piloter le suivi de contact sans mélanger les deux usages." />
      <div><button className="secondary" onClick={() => setImportOpen(true)}>Importer Excel</button><a className="button secondary" href="/api/export.xlsx">Exporter Excel</a><button onClick={() => setSelected('new')}>+ Ajouter un prospect</button></div>
    </div>
    <div className="filters compact-counters">
      {[
        ['Tous', c.all, ''], ['Non vérifiés', c.never, 'never_verified'], ['Vérifiés', c.verified, 'verified'], ['Incomplets', c.partial, 'partial_verification'], ['À contacter', c.due, 'due'], ['Contactés', c.contacted, 'contacted'], ['Réponses', c.responses, 'responses'], ['Rendez-vous', c.rdv, 'appointments']
      ].map(([l, n, f]: any) => <button className={filter === f ? 'active' : ''} onClick={() => setFilter(f)} key={l}><span>{l}</span><b>{n}</b></button>)}
    </div>
    <div className="prospect-toolbar">
      <input className="list-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher une personne, entreprise, fonction ou email…" />
      <div className="quick-filters">{quick.map(([label, value]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(filter === value ? '' : value)}>{label}</button>)}</div>
      <select value={company} onChange={e => setCompany(e.target.value)}><option value="">Toutes les entreprises</option>{companies.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
    </div>
    <div className="people-scroll"><div className="people">
      {list.map(p => {
        const verification = verificationSummary(p);
        return <button key={p.id} onClick={() => setSelected(p.id)}>
          <div className="avatar">{p.first_name?.[0]}{p.last_name?.[0]}</div>
          <div className="identity-cell"><b>{p.first_name} {p.last_name}</b><span>{p.role || p.exact_job_title || 'Rôle non classé'} · {p.company}</span></div>
          <div className={`verification-cell ${verification.tone}`}><small>Vérification</small><span><i />{verification.label}</span><em>{verification.detail}</em></div>
          <div className="email-cell"><small>Email</small><span>{p.primary_email || 'Email manquant'}</span><em>{p.email_verification === 'verified' ? `Vérifié ${formatDate(p.email_verified_at)}` : p.primary_email ? 'Non confirmé' : 'À renseigner'}</em></div>
          <div className="tracking-cell"><small>Suivi</small><strong>{trackingLabels[p.tracking_status] || 'À contacter'}</strong><em>{p.planned_contact_at ? `Prévu ${formatDate(p.planned_contact_at)}` : p.referent ? `Référent · ${p.referent}` : '—'}</em></div>
        </button>;
      })}
      {!list.length && <div className="empty-list">Aucun prospect pour ces filtres.</div>}
    </div></div>
    {selected && <Drawer id={selected} nextId={nextId} close={() => setSelected(null)} saved={(goNext) => { const n = goNext ? nextId : null; load(); setSelected(n); }} />}
    {importOpen && <ImportModal close={() => setImportOpen(false)} done={() => { setImportOpen(false); load(); }} />}
  </>;
}

function Drawer({ id, nextId, close, saved }: { id: string; nextId: string | null; close: () => void; saved: (goNext: boolean) => void }) {
  const [companies, setCompanies] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [referents, setReferents] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ activity_status: 'unknown', contactability_status: 'contactable', tracking: { status: 'to_contact' }, emails: [], phones: [] });
  const [original, setOriginal] = useState<any>();
  const [tab, setTab] = useState<'identity' | 'contact' | 'tracking' | 'history'>('identity');
  const [employmentTouched, setEmploymentTouched] = useState(false);
  const [verifyNow, setVerifyNow] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api<any[]>('/api/companies'), api<any[]>('/api/settings/roles'), api<any[]>('/api/settings/referents')]).then(([a, b, c]) => { setCompanies(a); setRoles(b); setReferents(c); });
    if (id !== 'new') api<any>('/api/prospects/' + id).then(d => {
      setOriginal(d);
      setForm({ ...d.prospect, tracking: d.tracking || { status: 'to_contact' }, emails: d.emails || [], phones: d.phones || [], trackingHistory: d.trackingHistory || [], company: d.company });
    });
  }, [id]);
  const setEmployment = (patch: any) => { setEmploymentTouched(true); setForm((f: any) => ({ ...f, ...patch })); };
  const save = async (goNext = false) => {
    setError('');
    try {
      await api(id === 'new' ? '/api/prospects' : '/api/prospects/' + id, {
        method: id === 'new' ? 'POST' : 'PUT',
        body: JSON.stringify({ ...form, mark_employment_verified: verifyNow || employmentTouched })
      });
      saved(goNext);
    } catch (e) { setError((e as Error).message); }
  };
  const trackingStatus = form.tracking?.status || 'to_contact';
  const currentHistory = form.trackingHistory?.find((h: any) => h.to_status === trackingStatus);
  const updateEmail = (i: number, patch: any) => setForm((f: any) => ({ ...f, emails: f.emails.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) }));
  const updatePhone = (i: number, patch: any) => setForm((f: any) => ({ ...f, phones: f.phones.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) }));
  return <div className="overlay"><div className="drawer">
    <div className="drawer-head"><div><small>{id === 'new' ? 'Nouveau prospect' : 'Fiche prospect'}</small><h2>{form.first_name || '—'} {form.last_name || ''}</h2></div><button className="icon" onClick={close}>×</button></div>
    <div className="drawer-tabs">
      <button className={tab === 'identity' ? 'active' : ''} onClick={() => setTab('identity')}>Identité & emploi</button>
      <button className={tab === 'contact' ? 'active' : ''} onClick={() => setTab('contact')}>Coordonnées</button>
      <button className={tab === 'tracking' ? 'active' : ''} onClick={() => setTab('tracking')}>Suivi de contact</button>
      <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Provenance</button>
    </div>
    <div className="drawer-body">
      {tab === 'identity' && <>
        <Group title="Identité"><Grid>
          <Field label="Prénom"><input value={form.first_name || ''} onChange={e => setForm({ ...form, first_name: e.target.value })} /></Field>
          <Field label="Nom"><input value={form.last_name || ''} onChange={e => setForm({ ...form, last_name: e.target.value })} /></Field>
          <Field label="Civilité"><select value={form.civility || ''} onChange={e => setForm({ ...form, civility: e.target.value })}><option value="">—</option><option>M.</option><option>Mme</option><option>Mlle</option></select></Field>
        </Grid></Group>
        <Group title="Emploi"><Grid>
          <Field label="Entreprise"><select value={form.company_id || ''} onChange={e => setEmployment({ company_id: e.target.value })}><option value="">Sélectionner…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></Field>
          <Field label="Rôle"><select value={form.role_id || ''} onChange={e => setEmployment({ role_id: e.target.value || null })}><option value="">Non classé</option>{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
          <Field label="Intitulé exact"><input value={form.exact_job_title || ''} onChange={e => setEmployment({ exact_job_title: e.target.value })} /></Field>
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
        <Group title="Étape actuelle"><Field label="Suivi de contact"><select value={trackingStatus} onChange={e => setForm({ ...form, tracking: { ...form.tracking, status: e.target.value } })}>{trackingStatuses.map(s => <option value={s} key={s}>{trackingLabels[s]}</option>)}</select></Field></Group>
        <div className="stage-context">
          <div className="stage-note"><small>Date de l’étape</small><b>{currentHistory?.changed_at ? formatDate(currentHistory.changed_at, true) : 'Elle sera enregistrée automatiquement lors du changement d’étape.'}</b></div>
          {stagesWithNextAction.has(trackingStatus) && <Field label={trackingStatus === 'to_contact' ? 'Contact planifié' : 'Prochaine action planifiée'}><input type="date" value={(form.tracking?.planned_contact_at || '').slice(0, 10)} onChange={e => setForm({ ...form, tracking: { ...form.tracking, planned_contact_at: e.target.value || null } })} /></Field>}
          {trackingStatus === 'response_received' && <div className="stage-note"><small>Réponse reçue</small><b>{form.tracking?.response_received_at ? formatDate(form.tracking.response_received_at, true) : 'La date sera enregistrée automatiquement à la sauvegarde.'}</b></div>}
          {stageAfterAppointment.has(trackingStatus) && <Field label="Date du rendez-vous"><input type="datetime-local" value={(form.tracking?.appointment_at || '').slice(0, 16)} onChange={e => setForm({ ...form, tracking: { ...form.tracking, appointment_at: e.target.value || null } })} /></Field>}
          {stageAfterAppointment.has(trackingStatus) && <Field label="Référent Circoe"><select value={form.tracking?.referent_id || ''} onChange={e => setForm({ ...form, tracking: { ...form.tracking, referent_id: e.target.value || null } })}><option value="">Non affecté</option>{referents.map(r => <option value={r.id} key={r.id}>{r.first_name} {r.last_name}</option>)}</select></Field>}
        </div>
        {form.trackingHistory?.length > 0 && <Group title="Historique des étapes">{form.trackingHistory.slice(0, 8).map((h: any) => <div className="row" key={h.id}><b>{trackingLabels[h.to_status] || h.to_status}</b><span>{formatDate(h.changed_at, true)}</span></div>)}</Group>}
      </>}
      {tab === 'history' && <>
        <Group title="Provenance">{original?.sources?.length ? original.sources.map((s: any) => <div className="row" key={s.id}><b>{s.source_type === 'excel_import' ? 'Import Excel' : s.source_type === 'manual' ? 'Saisie VIPER' : s.source_type}</b><span>{s.source_reference} · {formatDate(s.collected_at, true)}</span></div>) : <p className="muted">Aucune provenance enregistrée.</p>}</Group>
        <Group title="Historique récent">{original?.history?.length ? original.history.slice(0, 12).map((h: any) => <div className="row" key={h.id}><b>{h.action}</b><span>{formatDate(h.created_at, true)}</span></div>) : <p className="muted">Aucun changement enregistré.</p>}</Group>
      </>}
      {error && <p className="danger">{error}</p>}
    </div>
    <footer><button className="secondary" onClick={close}>Annuler</button>{nextId && id !== 'new' && <button className="secondary" onClick={() => save(true)}>Enregistrer et suivant</button>}<button onClick={() => save(false)}>Enregistrer</button></footer>
  </div></div>;
}

function ImportModal({ close, done }: { close: () => void; done: () => void }) {
  const [p, setP] = useState<any>();
  const [error, setError] = useState('');
  return <div className="overlay center"><div className="modal">
    <div className="drawer-head"><div><small>Excel → base normalisée</small><h2>Import contrôlé</h2></div><button className="icon" onClick={close}>×</button></div>
    <div className="drawer-body">{!p ? <label className="drop">Choisir un fichier XLSX, XLS ou CSV<input type="file" accept=".xlsx,.xls,.csv" onChange={async e => {
      const f = e.target.files?.[0]; if (!f) return; setError('');
      const fd = new FormData(); fd.append('file', f);
      const r = await fetch('/api/import/preview', { method: 'POST', body: fd });
      const body = await r.json(); if (!r.ok) setError(body.error || 'Import impossible'); else setP(body);
    }} /></label> : <>
      <div className="import-summary"><b>{p.rows?.length || 0} lignes détectées</b><span>Les semaines Sxx sont converties vers le lundi correspondant. Une valeur « vérifiée » sans date prend la date d’import.</span></div>
      {p.skippedSheets?.length > 0 && <p className="warnbox">Feuille ignorée explicitement : {p.skippedSheets.join(', ')}</p>}
      <div className="preview"><div className="preview-head"><span /><b>Prospect</b><b>Entreprise</b><b>Vérification</b><b>Contact prévu</b><b>Diagnostic</b></div>{p.rows?.slice(0, 120).map((r: any, i: number) => <div key={i}>
        <input type="checkbox" checked={!r.excluded} onChange={e => { const rows = [...p.rows]; rows[i] = { ...r, excluded: !e.target.checked }; setP({ ...p, rows }); }} />
        <b>{r.normalized.first_name} {r.normalized.last_name}</b><span>{r.normalized.company}</span>
        <span className={r.normalized.verification_state === 'verified' ? 'text-ok' : 'text-warn'}>{r.normalized.verification_state === 'verified' ? 'Vérifié' : 'À vérifier'}</span>
        <span>{r.normalized.planned_contact_at ? formatDate(r.normalized.planned_contact_at) : '—'}</span>
        <small>{r.diagnostics.map((d: any) => d.message).join(' · ') || 'Prêt'}</small>
      </div>)}</div>
    </>}{error && <p className="danger">{error}</p>}</div>
    <footer><button className="secondary" onClick={close}>Annuler</button>{p && <button onClick={async () => { try { await api('/api/import/commit', { method: 'POST', body: JSON.stringify(p) }); done(); } catch (e) { setError((e as Error).message); } }}>Confirmer l’import</button>}</footer>
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
  useEffect(() => { api('/api/auth/me').then(() => setState('in')).catch(() => setState('out')); }, []);
  if (state === 'loading') return <div className="login">Chargement…</div>;
  return state === 'in' ? <Shell /> : <Login onDone={() => setState('in')} />;
}
