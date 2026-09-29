// Workbench Contact (Task 10, décision 19) : fiche prospect à gauche (lecture + choix humain de l'état et de la semaine),
// séquence mail à droite (`ContactMailPanel`, Task 13). Le drawer Prospection n'est pas réutilisé : la correction des données
// se fait en ouvrant la fiche complète dans Prospection. Logique pure : `contactWorkbenchModel.ts`.
import React, { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ContactMailPanel } from './ContactMailPanel';
import { TrackingBadges } from './TrackingBadges';
import { WeekPlanner } from './WeekPlanner';
import {
  displayDate, initialStateChoice, isStateLocked, presenceNotice, prospectSummary, stateChangeConfirmation, stateChangeHint,
  stateChangeNotice, stateChangePatch, workbenchStateOptions, type ProspectDetail, type ProspectSummaryModel, type SelectionPresence,
  type StateChangeConfirmation, type TrackingMutation
} from './contactWorkbenchModel';
import { isProspectState, type ProspectState } from '../shared/contactWorkflow';

/** À monter avec `key={prospectId}` : annonces et erreurs sont propres au prospect affiché. */
type Props = {
  prospectId: string;
  /** Situation du prospect dans la liste courante (mention si sorti des filtres). */
  presence: SelectionPresence;
  /** Appelé après chaque mutation du suivi (état ou semaine) : le parent rafraîchit dashboard et liste. */
  onTrackingChanged: () => void;
  /** Ouvre la fiche complète dans Prospection (correction des données). */
  onOpenInProspection: (id: string) => void;
  onClose: () => void;
};

/** Fiche en lecture seule : aucun champ éditable (les corrections passent par Prospection). */
export function ProspectSummary({ summary }: { summary: ProspectSummaryModel }) {
  const { company } = summary;
  return <>
    <div className="workbench-group">
      <h3>Entreprise & fonction</h3>
      <dl className="workbench-facts">
        <dt>Entreprise</dt><dd>{company ? <>{company.name}{(company.website || company.domain) && <span className="muted"> · {company.website || company.domain}</span>}</> : 'Non renseignée'}</dd>
        <dt>Fonction</dt><dd>{summary.jobTitle ?? 'Non renseignée'}</dd>
        <dt>Rôle</dt><dd>{summary.role ?? 'Non classé'}</dd>
        <dt>Emploi</dt><dd>{summary.employmentVerifiedAt ? `Vérifié le ${displayDate(summary.employmentVerifiedAt)}` : 'Non vérifié'}</dd>
      </dl>
    </div>
    <div className="workbench-group">
      <h3>Coordonnées</h3>
      {summary.doNotContact && <p className="danger">À ne plus contacter{summary.doNotContact.reason ? ` : ${summary.doNotContact.reason}` : ''}.</p>}
      {summary.emails.length ? <ul className="workbench-list">{summary.emails.map(e => <li key={e.address}>
        <span className="workbench-address">{e.address}</span><span className="muted">{[e.primary ? 'Principal' : null, e.verification].filter(Boolean).join(' · ')}</span>
      </li>)}</ul> : <p className="muted">Aucun email.</p>}
      {summary.phones.length > 0 && <ul className="workbench-list">{summary.phones.map(x => <li key={x.number}>
        <span>{x.number}</span><span className="muted">{[x.type, x.primary ? 'Principal' : null, x.verification].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>}
    </div>
  </>;
}

function StateHistory({ summary }: { summary: ProspectSummaryModel }) {
  if (!summary.history.length) return <p className="muted">Aucun changement d’état enregistré.</p>;
  return <ul className="workbench-list">{summary.history.map(h => <li key={h.id}><span>{h.label}</span><span className="muted">{displayDate(h.at, true)} · {h.by}</span></li>)}</ul>;
}

/** Choix humain de l'état : sélection puis « Enregistrer l'état » ; confirmation si la séquence est annulée. */
function StateControl({ summary, doNotContact, onSave }: {
  summary: ProspectSummaryModel; doNotContact: boolean; onSave: (to: ProspectState) => Promise<boolean>;
}) {
  const saved = summary.tracking.status;
  const [choice, setChoice] = useState<ProspectState | null>(() => initialStateChoice(saved, doNotContact));
  const [confirm, setConfirm] = useState<StateChangeConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  // Focus : sur la confirmation à son ouverture ; retour au sélecteur (réactivé) à sa fermeture sans enregistrement.
  const refocusSelect = useRef(false);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
    else if (refocusSelect.current) { refocusSelect.current = false; selectRef.current?.focus(); }
  }, [confirm]);

  const selectId = `workbench-state-${summary.id}`;
  if (isStateLocked(saved)) return <p className="muted">« Ignoré » est définitif : l’état ne peut plus être modifié.</p>;
  const week = { year: summary.tracking.year, week: summary.tracking.week };
  const changed = choice !== null && choice !== saved;
  const hint = choice ? stateChangeHint(saved, choice, week) : null;
  const apply = async (to: ProspectState) => {
    setBusy(true);
    const ok = await onSave(to);
    setBusy(false);
    if (!ok) { refocusSelect.current = true; setConfirm(null); }
  };
  const request = () => {
    if (!choice || !changed) return;
    const confirmation = stateChangeConfirmation(saved, choice, week);
    if (confirmation) setConfirm(confirmation); else void apply(choice);
  };
  const cancel = () => { refocusSelect.current = true; setConfirm(null); };

  return <div className="workbench-state">
    <label htmlFor={selectId}>État (choix humain)</label>
    <div className="workbench-state-row">
      <select id={selectId} ref={selectRef} value={choice ?? ''} disabled={busy || !!confirm} onChange={e => setChoice(isProspectState(e.target.value) ? e.target.value : null)}>
        {choice === null && <option value="" disabled>{saved} (hors contrat)</option>}
        {workbenchStateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button type="button" disabled={busy || !changed || !!confirm} onClick={request}>Enregistrer l’état</button>
    </div>
    {hint && changed && !confirm && <p className="muted">{hint}</p>}
    {confirm && choice && <div className="warnbox workbench-confirm" role="alertdialog" aria-modal="false" aria-labelledby={`${selectId}-confirm-title`} tabIndex={-1} ref={confirmRef}
      onKeyDown={e => { if (e.key === 'Escape') cancel(); }}>
      <b id={`${selectId}-confirm-title`}>{confirm.title}</b>
      {confirm.lines.map(line => <p key={line}>{line}</p>)}
      <div className="workbench-confirm-actions">
        <button type="button" disabled={busy} onClick={() => apply(choice)}>{confirm.confirmLabel}</button>
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>Annuler</button>
      </div>
    </div>}
  </div>;
}

export function ContactWorkbench({ prospectId, presence, onTrackingChanged, onOpenInProspection, onClose }: Props) {
  const [loaded, setLoaded] = useState<{ id: string; detail: ProspectDetail | null; error: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const trackingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    api<ProspectDetail>(`/api/prospects/${prospectId}`)
      .then(detail => { if (current) setLoaded({ id: prospectId, detail, error: '' }); })
      .catch(e => { if (current) setLoaded(l => ({ id: prospectId, detail: l?.id === prospectId ? l.detail : null, error: (e as Error).message })); });
    return () => { current = false; };
  }, [prospectId, reload]);

  // Rechargement : la fiche affichée reste visible ; seul un changement de prospect montre « Chargement… ».
  const detail = loaded?.id === prospectId ? loaded.detail : null;
  const loadError = loaded?.id === prospectId ? loaded.error : '';
  const afterMutation = (message: string) => {
    setNotice(message);
    setReload(n => n + 1);
    onTrackingChanged();
  };

  if (!detail) {
    return <div className="contact-workbench-state" aria-live="polite">
      {loadError ? <><p className="danger" role="alert">Fiche indisponible : {loadError}</p><button type="button" className="secondary small" onClick={onClose}>Fermer</button></>
        : <p className="muted">Chargement de la fiche…</p>}
    </div>;
  }

  const summary = prospectSummary(detail);
  const doNotContact = !!summary.doNotContact;
  const presenceText = presenceNotice(presence, summary.tracking.status);
  const saveState = async (to: ProspectState): Promise<boolean> => {
    setError('');
    const previousWeek = { year: summary.tracking.year, week: summary.tracking.week };
    try {
      const result = await api<TrackingMutation>(`/api/prospects/${prospectId}/tracking`, { method: 'PATCH', body: JSON.stringify(stateChangePatch(to)) });
      afterMutation(stateChangeNotice(result, previousWeek));
      trackingRef.current?.focus(); // le contrôle d'état est remonté : le focus clavier reste dans le bloc suivi
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  };

  return <div className="contact-workbench">
    <section className="contact-workbench-fiche" aria-labelledby={`workbench-name-${summary.id}`}>
      <div className="workbench-head">
        <div>
          <small>Fiche prospect</small>
          <h2 id={`workbench-name-${summary.id}`}>{summary.civility ? `${summary.civility} ` : ''}{summary.name}</h2>
          <span className="muted">{[summary.jobTitle, summary.company?.name].filter(Boolean).join(' · ') || 'Fonction et entreprise non renseignées'}</span>
          <TrackingBadges status={summary.tracking.status} year={summary.tracking.year} week={summary.tracking.week} />
        </div>
        <div className="workbench-head-actions">
          <button type="button" className="secondary small" onClick={() => onOpenInProspection(summary.id)}>Corriger dans Prospection</button>
          <button type="button" className="icon" aria-label="Fermer la fiche" onClick={onClose}>×</button>
        </div>
      </div>
      {presenceText && <p className="warnbox">{presenceText}</p>}
      {loadError && <p className="danger" role="alert">Actualisation impossible : {loadError}</p>}
      <ProspectSummary summary={summary} />
      <div className="workbench-group workbench-tracking" ref={trackingRef} tabIndex={-1} aria-labelledby={`workbench-tracking-${summary.id}`}>
        <h3 id={`workbench-tracking-${summary.id}`}>Suivi de contact</h3>
        <StateControl key={`state:${summary.id}:${summary.tracking.status}`} summary={summary} doNotContact={doNotContact} onSave={saveState} />
        {summary.tracking.stateSince && <p className="muted">État choisi le {displayDate(summary.tracking.stateSince, true)}.</p>}
        <WeekPlanner key={`week:${summary.id}:${summary.tracking.status}`} prospectId={summary.id} tracking={detail.tracking} stateSince={summary.tracking.stateSince}
          onSaved={(_tracking, message) => afterMutation(message)} />
        <div aria-live="polite">{notice && <p className="workbench-notice">{notice}</p>}{error && <p className="danger">{error}</p>}</div>
      </div>
      <div className="workbench-group">
        <h3>Historique des états</h3>
        <StateHistory summary={summary} />
      </div>
    </section>
    <section className="contact-workbench-mail" aria-label="Séquence mail">
      <ContactMailPanel prospect={summary} onTrackingChanged={() => { setReload(n => n + 1); onTrackingChanged(); }} />
    </section>
  </div>;
}
