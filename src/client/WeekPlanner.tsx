// Sélecteur de prochaine semaine (Task 06) : choix humain, enregistré seul via `PATCH /api/prospects/:id/tracking`
// (aucun `status` envoyé : l'état reste inchangé, `neutral` compris). La cadence n'est qu'une proposition à confirmer.
import React, { useRef, useState } from 'react';
import { api } from './api';
import { WeekBadge } from './TrackingBadges';
import {
  cadenceSuggestion, canPlanWeek, initialPlanningWeek, planningWeekOptions, planningYearOptions, relativeWeekLabel, sameIsoWeek,
  shiftPlanningWeek, storedWeek, weekMondayLabel, weekPlanningPatch, withPlanningWeek, withPlanningYear
} from './weekPlanning';
import { formatIsoWeekBadge, type IsoWeek } from '../shared/contactWorkflow';

type SavedTracking = { status?: string | null; next_action_year?: number | null; next_action_week?: number | null; planned_contact_at?: string | null } | null | undefined;
/** À monter une fois le suivi enregistré chargé, avec `key` = prospect : le pré-remplissage est calculé au montage. */
type Props = {
  prospectId: string;
  /** Suivi enregistré (serveur), jamais le brouillon de la fiche. */
  tracking: SavedTracking;
  /** Date du choix de l'état enregistré (historique), base de la proposition de cadence. */
  stateSince?: string | null;
  /** Appelé avec le suivi renvoyé par le service et un message de confirmation (à annoncer par le parent). */
  onSaved: (tracking: Record<string, unknown>, notice: string) => void;
};

const prefillNotes = { current: '', legacy_date: 'Pré-remplie depuis l’ancienne « date prévue » : à confirmer.', cadence: 'Pré-remplie selon la cadence : à confirmer.', this_week: '' };

export function WeekPlanner({ prospectId, tracking, stateSince, onSaved }: Props) {
  const [today] = useState(() => new Date());
  const saved = storedWeek(tracking?.next_action_year, tracking?.next_action_week);
  const cadence = cadenceSuggestion(tracking?.status, stateSince, today);
  // Pré-remplissage calculé une fois au montage ; ensuite la sélection reste celle de l'humain.
  const [prefill] = useState(() => initialPlanningWeek({ current: saved, legacyPlannedAt: tracking?.planned_contact_at, cadence, today }));
  const [selected, setSelected] = useState<IsoWeek>(prefill.week);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentRef = useRef<HTMLDivElement>(null);

  if (!canPlanWeek(tracking?.status)) {
    return <p className="muted">« Ignoré » est définitif : aucune prochaine semaine ne peut être planifiée.</p>;
  }

  const submit = async (value: IsoWeek | null) => {
    setError(''); setBusy(true);
    try {
      const result = await api<{ tracking: Record<string, unknown> }>(`/api/prospects/${prospectId}/tracking`, { method: 'PATCH', body: JSON.stringify(weekPlanningPatch(value)) });
      onSaved(result.tracking, value ? `Semaine ${formatIsoWeekBadge(value)} ${value.year} enregistrée.` : 'Échéance retirée.');
      currentRef.current?.focus(); // le bouton utilisé devient inactif : le focus clavier va sur la semaine enregistrée
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const unchanged = sameIsoWeek(saved, selected);
  const idBase = `week-planner-${prospectId}`;
  return <div className="week-planner" role="group" aria-labelledby={`${idBase}-title`}>
    <div className="week-planner-current" ref={currentRef} tabIndex={-1}>
      <small id={`${idBase}-title`}>Prochaine semaine</small>
      <b>{saved ? <><WeekBadge year={saved.year} week={saved.week} /> <span className="muted">{saved.year} · {relativeWeekLabel(saved, today)}</span></> : 'Aucune semaine planifiée'}</b>
    </div>
    <div className="week-planner-controls">
      <button type="button" className="secondary small" aria-label="Semaine précédente" disabled={busy} onClick={() => setSelected(shiftPlanningWeek(selected, -1))}>‹</button>
      <label className="sr-only" htmlFor={`${idBase}-year`}>Année ISO</label>
      <select id={`${idBase}-year`} value={selected.year} disabled={busy} onChange={e => setSelected(withPlanningYear(selected, Number(e.target.value)))}>
        {planningYearOptions(selected, today).map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      <label className="sr-only" htmlFor={`${idBase}-week`}>Semaine ISO</label>
      <select id={`${idBase}-week`} value={selected.week} disabled={busy} onChange={e => setSelected(withPlanningWeek(selected, Number(e.target.value)))}>
        {planningWeekOptions(selected.year).map(o => <option key={o.week} value={o.week}>{o.label}</option>)}
      </select>
      <button type="button" className="secondary small" aria-label="Semaine suivante" disabled={busy} onClick={() => setSelected(shiftPlanningWeek(selected, 1))}>›</button>
    </div>
    <p className="muted week-planner-help">Semaine du {weekMondayLabel(selected)} {selected.year} · {relativeWeekLabel(selected, today)}. {!saved && prefillNotes[prefill.source]}</p>
    {cadence && !sameIsoWeek(cadence.week, selected) && <button type="button" className="secondary small" disabled={busy} onClick={() => setSelected(cadence.week)}>
      Proposition cadence : {formatIsoWeekBadge(cadence.week)} {cadence.week.year} ({cadence.label})
    </button>}
    <div className="week-planner-actions">
      <button type="button" disabled={busy || unchanged} onClick={() => submit(selected)}>{saved ? `Déplacer en ${formatIsoWeekBadge(selected)}` : `Planifier ${formatIsoWeekBadge(selected)}`}</button>
      {saved && <button type="button" className="secondary" disabled={busy} onClick={() => submit(null)}>Retirer l’échéance</button>}
    </div>
    <p className="muted">Enregistrée immédiatement, sans changer l’état. La semaine n’est pas une date d’envoi : l’heure se choisit à la programmation du mail.</p>
    <div aria-live="polite">{error && <p className="danger">{error}</p>}</div>
  </div>;
}
