// Zone mail du workbench Contact (Task 13, décisions 20-25, 29) : trois onglets Contact / R1 / R2, un éditeur type boîte mail
// par étape (From prérempli depuis la config, À/Cc/Cci, objet, corps), enregistrement explicite du brouillon (verrou optimiste
// `expected_revision`), validation humaine confirmée, programmation date + heure explicites (aucune heure par défaut),
// déprogrammation, annulation, réouverture. Envoyé = lecture seule ; séquence fermée = édition/validation/programmation bloquées.
// Aucune action ici ne change l'état du prospect. Logique pure : `contactMailModel.ts` ; contrat HTTP : Task 12.
// Task 14 (génération IA) : passer `renderGeneration` à `MailEditor` (rendu en tête de la barre d'actions `.mail-actions`).
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { ProspectSummaryModel } from './contactWorkbenchModel';
import {
  actionConfirmation, actionNotice, formFieldErrors, formFromMessage, formPayload, isFormDirty, localDateValue, localTimeZoneLabel,
  mailActions, mailErrorView, mailTabs, messageOf, messageStatusBadge, messageStatusLine, messageUrl, messagesUrl, previousStep,
  scheduleToIso, tabKeyTarget, type ContactMessage, type MailConfirmation, type MailErrorView, type MailField, type MailForm,
  type MessageAction, type MessageMutationResult, type ProspectMessagesResponse
} from './contactMailModel';
import { contactMessageStepLabels, contactMessageSteps, type ContactMessageStatus, type ContactMessageStep } from '../shared/contactWorkflow';

export type ContactMailPanelProps = {
  /** Fiche du prospect sélectionné (lecture seule) ; un changement d'état ou de blocage recharge les messages. */
  prospect: ProspectSummaryModel;
  /** Réservé : l'éditeur ne modifie jamais le suivi du prospect, il ne l'appelle donc pas. */
  onTrackingChanged: () => void;
};

/** Contexte fourni au bouton de génération IA (Task 14) ; `onGenerated` applique le message renvoyé par l'API. */
export type MailGenerationContext = {
  step: ContactMessageStep; message: ContactMessage | null; editable: boolean; dirty: boolean; busy: boolean;
  onGenerated: (result: MessageMutationResult) => void;
};

export function MessageStatusBadge({ status }: { status: ContactMessageStatus | null }) {
  return <span className={`message-badge ${status ?? 'empty'}`}><span className="sr-only">Statut du message : </span>{messageStatusBadge(status)}</span>;
}

/** Vue en lecture seule d'un message (envoyé, annulé, séquence fermée, référence de l'étape précédente). */
function MessageView({ message }: { message: ContactMessage }) {
  const rows: [string, string][] = [
    ['De', message.from_email ?? '—'], ['À', message.to_recipients.join(', ') || '—'],
    ...(message.cc_recipients.length ? [['Cc', message.cc_recipients.join(', ')] as [string, string]] : []),
    ...(message.bcc_recipients.length ? [['Cci', message.bcc_recipients.join(', ')] as [string, string]] : []),
    ['Objet', message.subject || '(sans objet)']
  ];
  return <div className="mail-view">
    <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
    <div className="mail-view-body">{message.body_text || <span className="muted">(corps vide)</span>}</div>
  </div>;
}

function ConfirmBox({ id, confirmation, busy, onConfirm, onCancel }: {
  id: string; confirmation: MailConfirmation; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className="warnbox workbench-confirm" role="alertdialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} ref={ref}
    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
    <b id={`${id}-title`}>{confirmation.title}</b>
    {confirmation.lines.map(line => <p key={line}>{line}</p>)}
    <div className="workbench-confirm-actions">
      <button type="button" disabled={busy} onClick={onConfirm}>{confirmation.confirmLabel}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Retour</button>
    </div>
  </div>;
}

type PendingConfirm = { action: 'validate' | 'cancel' } | { action: 'schedule'; iso: string; confirmation: MailConfirmation };

type EditorProps = {
  prospectId: string;
  step: ContactMessageStep;
  data: ProspectMessagesResponse;
  /** Modifications non enregistrées de l'étape (`undefined` = version enregistrée). */
  localForm: MailForm | undefined;
  onLocalForm: (form: MailForm | undefined) => void;
  /** Modifications mises de côté après un conflit de révision. */
  conflictForm: MailForm | undefined;
  onConflict: (form: MailForm | undefined) => void;
  onMessage: (message: ContactMessage) => void;
  onReload: () => void;
  renderGeneration?: (ctx: MailGenerationContext) => ReactNode;
};

export function MailEditor({ prospectId, step, data, localForm, onLocalForm, conflictForm, onConflict, onMessage, onReload, renderGeneration }: EditorProps) {
  const message = messageOf(data, step);
  const saved = formFromMessage(message, data.defaults);
  const form = localForm ?? saved;
  const dirty = isFormDirty(localForm, saved);
  const [busy, setBusy] = useState(false);
  // Une erreur de saisie ne vaut que pour la version du message sur laquelle elle a été levée (une annulation externe l'efface) ;
  // une erreur qui a provoqué un rechargement (conflit, séquence fermée…) reste affichée jusqu'à la prochaine action.
  const version = `${message?.status ?? 'none'}:${message?.revision ?? 0}`;
  const [errorState, setErrorState] = useState<{ view: MailErrorView; version: string } | null>(null);
  const error = errorState && (errorState.view.reload || errorState.version === version) ? errorState.view : null;
  const setError = (view: MailErrorView | null) => setErrorState(view ? { view, version } : null);
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [schedule, setSchedule] = useState({ date: '', time: '' });
  const [showCopies, setShowCopies] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const actions = mailActions({
    message, prospectState: data.prospect.state, doNotContact: data.prospect.do_not_contact, sequenceClosed: data.prospect.sequence_closed,
    dirty, busy: busy || !!confirm
  });
  const id = `mail-${prospectId}-${step}`;
  const label = contactMessageStepLabels[step];
  const previous = previousStep(step);
  const previousMessage = previous ? messageOf(data, previous) : null;
  const copiesVisible = showCopies || !!form.cc.trim() || !!form.bcc.trim();

  const setField = (field: MailField, value: string) => {
    onLocalForm({ ...form, [field]: value });
    if (error?.fields[field]) setError({ ...error, fields: { ...error.fields, [field]: undefined } });
  };
  const fail = (e: unknown) => {
    const view = e instanceof ApiError ? mailErrorView(e, form) : mailErrorView({ message: (e as Error).message }, form);
    setError(view);
    if (view.conflict) {
      if (dirty) onConflict(form);
      onLocalForm(undefined);
    }
    if (view.reload) onReload();
  };
  const run = async (kind: 'save' | MessageAction, request: () => Promise<MessageMutationResult>) => {
    setBusy(true); setError(null); setNotice('');
    try {
      const result = await request();
      onMessage(result.message);
      if (kind === 'save') onLocalForm(undefined);
      if (kind === 'schedule') setSchedule({ date: '', time: '' });
      setNotice(actionNotice(kind, step, result));
      onReload();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const save = () => {
    const local = formFieldErrors(form);
    if (Object.keys(local).length) { setError({ message: 'Corrigez les adresses signalées avant d’enregistrer.', fields: local, reload: false, conflict: false }); return; }
    void run('save', () => api<MessageMutationResult>(messageUrl(prospectId, step), { method: 'PUT', body: JSON.stringify(formPayload(form, message?.revision ?? null)) }));
  };
  const post = (action: MessageAction, body: Record<string, unknown> = {}) => {
    if (!message) return;
    void run(action, () => api<MessageMutationResult>(messageUrl(prospectId, step, action), { method: 'POST', body: JSON.stringify({ expected_revision: message.revision, ...body }) }));
  };
  const openConfirm = (pending: PendingConfirm) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(null); setNotice('');
    setConfirm(pending);
  };
  const closeConfirm = () => { setConfirm(null); requestAnimationFrame(() => returnFocus.current?.focus()); };
  const requestSchedule = () => {
    const parsed = scheduleToIso(schedule, new Date());
    if (!parsed.ok) { setError({ message: parsed.error, fields: { schedule: parsed.error }, reload: false, conflict: false }); return; }
    openConfirm({ action: 'schedule', iso: parsed.iso, confirmation: actionConfirmation('schedule', step, { at: parsed.at, zone: localTimeZoneLabel(parsed.at) }) });
  };
  const confirmPending = () => {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    if (pending.action === 'schedule') post('schedule', { scheduled_at: pending.iso });
    else post(pending.action);
  };
  const confirmation = confirm ? (confirm.action === 'schedule' ? confirm.confirmation : actionConfirmation(confirm.action, step)) : null;

  const fieldError = (field: MailField | 'schedule') => error?.fields[field]
    ? <span className="field-error" id={`${id}-${field}-error`}>{error.fields[field]}</span> : null;
  const inputProps = (field: MailField) => ({
    id: `${id}-${field}`, value: form[field], readOnly: !actions.editable,
    'aria-invalid': error?.fields[field] ? true : undefined,
    'aria-describedby': error?.fields[field] ? `${id}-${field}-error` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setField(field, e.target.value)
  });
  const row = (field: MailField, text: string, extra?: ReactNode) => <div className="mail-row">
    <label htmlFor={`${id}-${field}`}>{text}</label>
    <div className="mail-row-input">
      <input type="text" autoComplete="off" spellCheck={false} {...inputProps(field)} />
      {extra}
      {fieldError(field)}
    </div>
  </div>;

  return <div className="mail-editor">
    <div className="mail-status">
      <p>{messageStatusLine(message, data.prospect.sequence_closed)}</p>
      {(message?.status === 'validated' || message?.status === 'scheduled') && !dirty && actions.editable &&
        <p className="muted">Toute modification enregistrée repassera ce message en Brouillon (revalidation obligatoire).</p>}
    </div>

    {conflictForm && <div className="warnbox mail-conflict" role="alert">
      <p>Vos modifications non enregistrées ont été mises de côté : la version enregistrée affichée est plus récente.</p>
      <div className="workbench-confirm-actions">
        {actions.editable && <button type="button" className="secondary small" onClick={() => { onLocalForm({ ...conflictForm }); onConflict(undefined); }}>Reprendre mes modifications</button>}
        <button type="button" className="secondary small" onClick={() => onConflict(undefined)}>Garder la version enregistrée</button>
      </div>
    </div>}

    {actions.editable ? <form className="mail-form" onSubmit={e => e.preventDefault()} aria-label={`Message ${label}`}>
      {row('from', 'De', !form.from.trim() && !data.defaults.from_email
        ? <span className="muted">Aucune adresse d’expédition configurée : saisissez-la.</span> : null)}
      {row('to', 'À', copiesVisible ? null
        : <button type="button" className="mail-link" onClick={() => setShowCopies(true)}>Ajouter Cc / Cci</button>)}
      {copiesVisible && row('cc', 'Cc')}
      {copiesVisible && row('bcc', 'Cci')}
      <p className="muted mail-hint">Plusieurs adresses : séparez-les par une virgule.</p>
      {row('subject', 'Objet')}
      <div className="mail-body">
        <label htmlFor={`${id}-body`} className="sr-only">Corps du message</label>
        <textarea rows={14} placeholder="Corps du message" {...inputProps('body')} />
        {fieldError('body')}
      </div>
      <p className="muted mail-hint">Pièces jointes : non prises en charge dans cette version.</p>
    </form> : message ? <MessageView message={message} /> : null}

    {actions.notes.length > 0 && <div className="mail-notes">{actions.notes.map(n => <p key={n} className="warnbox">{n}</p>)}</div>}
    {dirty && <p className="mail-dirty" role="status">Modifications non enregistrées.</p>}

    {actions.showSchedule && <fieldset className="mail-schedule" disabled={!actions.canSchedule}>
      <legend>Programmer l’envoi</legend>
      <div className="mail-schedule-row">
        <label>Date<input type="date" value={schedule.date} min={localDateValue(new Date())}
          aria-invalid={error?.fields.schedule ? true : undefined} onChange={e => setSchedule(s => ({ ...s, date: e.target.value }))} /></label>
        <label>Heure<input type="time" value={schedule.time}
          aria-invalid={error?.fields.schedule ? true : undefined} onChange={e => setSchedule(s => ({ ...s, time: e.target.value }))} /></label>
        <button type="button" onClick={requestSchedule}>Programmer…</button>
      </div>
      <p className="muted">Heure locale : {localTimeZoneLabel()}. Aucune heure n’est proposée par défaut.</p>
      {fieldError('schedule')}
    </fieldset>}

    <div className="mail-actions" role="group" aria-label={`Actions du message ${label}`}>
      {renderGeneration && <div className="mail-actions-generation">{renderGeneration({
        step, message, editable: actions.editable, dirty, busy: busy || !!confirm,
        onGenerated: result => { onMessage(result.message); onLocalForm(undefined); onReload(); }
      })}</div>}
      {actions.editable && <button type="button" className={actions.showValidate || actions.showSchedule ? 'secondary' : ''} disabled={!actions.canSave} onClick={save}>{actions.saveLabel}</button>}
      {actions.editable && dirty && <button type="button" className="secondary" disabled={busy} onClick={() => { onLocalForm(undefined); setError(null); }}>Abandonner les modifications</button>}
      {actions.showValidate && <button type="button" disabled={!actions.canValidate} onClick={() => openConfirm({ action: 'validate' })}>Valider…</button>}
      {actions.showUnschedule && <button type="button" className="secondary" disabled={!actions.canUnschedule} onClick={() => post('unschedule')}>Déprogrammer</button>}
      {actions.showReopen && <button type="button" disabled={!actions.canReopen} onClick={() => post('reopen')}>Rouvrir</button>}
      {actions.showCancel && <button type="button" className="secondary danger-action" disabled={!actions.canCancel} onClick={() => openConfirm({ action: 'cancel' })}>Annuler le message…</button>}
    </div>

    {confirm && confirmation && <ConfirmBox id={`${id}-confirm`} confirmation={confirmation} busy={busy} onConfirm={confirmPending} onCancel={closeConfirm} />}
    <div aria-live="polite" className="mail-feedback">
      {notice && <p className="workbench-notice">{notice}</p>}
      {error && <p className="danger" role="alert">{error.message}</p>}
    </div>

    {previous && previousMessage && <details className="mail-reference">
      <summary>Message {contactMessageStepLabels[previous]} (référence, lecture seule) <MessageStatusBadge status={previousMessage.status} /></summary>
      <MessageView message={previousMessage} />
    </details>}
  </div>;
}

export function ContactMailPanel({ prospect }: ContactMailPanelProps) {
  const [loaded, setLoaded] = useState<{ data: ProspectMessagesResponse | null; error: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [active, setActive] = useState<ContactMessageStep>('contact');
  const [local, setLocal] = useState<Partial<Record<ContactMessageStep, MailForm>>>({});
  const [conflicts, setConflicts] = useState<Partial<Record<ContactMessageStep, MailForm>>>({});
  const tabRefs = useRef<Partial<Record<ContactMessageStep, HTMLButtonElement | null>>>({});
  const doNotContact = !!prospect.doNotContact;
  const state = prospect.tracking.status;

  // Recharge aussi quand l'état ou le blocage du prospect change (annulation des messages futurs, décision 29).
  useEffect(() => {
    let current = true;
    api<ProspectMessagesResponse>(messagesUrl(prospect.id))
      .then(data => { if (current) setLoaded({ data, error: '' }); })
      .catch(e => { if (current) setLoaded(l => ({ data: l?.data ?? null, error: (e as Error).message })); });
    return () => { current = false; };
  }, [prospect.id, state, doNotContact, reload]);

  const data = loaded?.data ?? null;
  const titleId = `contact-mail-title-${prospect.id}`;
  if (!data) {
    return <div className="contact-mail">
      <h3 id={titleId}>Séquence mail</h3>
      <div aria-live="polite">{loaded?.error ? <p className="danger" role="alert">Messages indisponibles : {loaded.error}</p> : <p className="muted">Chargement des messages…</p>}</div>
    </div>;
  }

  const dirtySteps = contactMessageSteps.filter(step => isFormDirty(local[step], formFromMessage(messageOf(data, step), data.defaults)));
  const tabs = mailTabs(data, dirtySteps);
  const select = (step: ContactMessageStep, focus = false) => {
    setActive(step);
    if (focus) tabRefs.current[step]?.focus();
  };
  const applyMessage = (message: ContactMessage) => setLoaded(l => l?.data ? {
    ...l, data: { ...l.data, messages: l.data.messages.map(m => m.step === message.step ? { ...m, message } : m) }
  } : l);
  const setStepForm = (step: ContactMessageStep) => (form: MailForm | undefined) => setLocal(l => ({ ...l, [step]: form }));
  const setStepConflict = (step: ContactMessageStep) => (form: MailForm | undefined) => setConflicts(c => ({ ...c, [step]: form }));

  return <div className="contact-mail">
    <h3 id={titleId}>Séquence mail</h3>
    {loaded?.error && <p className="danger" role="alert">Actualisation impossible : {loaded.error}</p>}
    <div className="mail-tabs" role="tablist" aria-labelledby={titleId}
      onKeyDown={e => { const target = tabKeyTarget(e.key, active); if (target) { e.preventDefault(); select(target, true); } }}>
      {tabs.map(tab => <button key={tab.step} type="button" role="tab" id={`mail-tab-${prospect.id}-${tab.step}`}
        aria-selected={tab.step === active} aria-controls={`mail-panel-${prospect.id}-${tab.step}`} tabIndex={tab.step === active ? 0 : -1}
        ref={el => { tabRefs.current[tab.step] = el; }} className={tab.step === active ? 'active' : ''} onClick={() => select(tab.step)}>
        <span>{tab.label}</span>
        <MessageStatusBadge status={tab.status} />
        {tab.dirty && <span className="mail-tab-dirty" title="Modifications non enregistrées"><span aria-hidden="true">•</span><span className="sr-only">modifications non enregistrées</span></span>}
      </button>)}
    </div>
    {contactMessageSteps.map(step => <div key={step} role="tabpanel" id={`mail-panel-${prospect.id}-${step}`} aria-labelledby={`mail-tab-${prospect.id}-${step}`}
      hidden={step !== active} tabIndex={0} className="mail-panel">
      <MailEditor prospectId={prospect.id} step={step} data={data} localForm={local[step]} onLocalForm={setStepForm(step)}
        conflictForm={conflicts[step]} onConflict={setStepConflict(step)} onMessage={applyMessage} onReload={() => setReload(n => n + 1)} />
    </div>)}
  </div>;
}
