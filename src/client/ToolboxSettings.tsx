// Panneau Paramètres « CIRCOE Toolbox » (Task 15) : état de connexion et bouton de connexion OAuth (redirection vers la Toolbox).
// Aucun envoi, aucun secret : le serveur ne renvoie que des états et des codes.
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { readToolboxCallback, toolboxPanelModel, withoutToolboxCallback, type ToolboxStatusView } from './toolboxModel';

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function ToolboxStatusPanel({ status, busy, notice, onConnect, onDisconnect }: {
  status: ToolboxStatusView | null; busy: boolean; notice: { ok: boolean; message: string } | null;
  onConnect: () => void; onDisconnect: () => void;
}) {
  const model = status ? toolboxPanelModel(status) : null;
  return <div className="panel toolbox-panel">
    <h3>CIRCOE Toolbox · brouillons Infomaniak</h3>
    {!status || !model ? <p className="muted">Chargement…</p> : <>
      <div className="row"><b>État</b><span className={`toolbox-state ${model.tone}`}>{model.label}</span></div>
      <p className="muted">{model.explanation}</p>
      {status.toolboxOrigin && <div className="row"><b>Serveur</b><span>{status.toolboxOrigin}</span></div>}
      {status.connection && <>
        <div className="row"><b>Connectée le</b><span>{formatDate(status.connection.connectedAt)}{status.connection.connectedBy ? ` · ${status.connection.connectedBy}` : ''}</span></div>
        <div className="row"><b>Expire le</b><span>{formatDate(status.connection.expiresAt)}{status.connection.refreshable ? ' (renouvelable)' : ''}</span></div>
      </>}
      {status.enabled && status.cleanups.pending > 0 && <div className="row"><b>Brouillons à supprimer</b><span>{status.cleanups.pending}{status.cleanups.failing ? ` dont ${status.cleanups.failing} en échec (nouvel essai automatique)` : ''}</span></div>}
      <div className="inline">
        {model.connectLabel && <button type="button" disabled={busy} onClick={onConnect}>{busy ? 'Redirection…' : model.connectLabel}</button>}
        {model.canDisconnect && <button type="button" className="secondary" disabled={busy} onClick={onDisconnect}>Oublier la connexion</button>}
      </div>
    </>}
    <p className="muted" role="status" aria-live="polite">{notice?.message ?? ''}</p>
  </div>;
}

export function ToolboxSettings() {
  const [status, setStatus] = useState<ToolboxStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(() => typeof window === 'undefined' ? null : readToolboxCallback(window.location.search));
  const load = () => api<ToolboxStatusView>('/api/toolbox/status').then(setStatus).catch(() => setNotice({ ok: false, message: 'État de la Toolbox indisponible.' }));
  useEffect(() => {
    if (readToolboxCallback(window.location.search)) window.history.replaceState(null, '', withoutToolboxCallback(window.location.href));
    load();
  }, []);
  const connect = async () => {
    setBusy(true);
    try {
      const { authorizationUrl } = await api<{ authorizationUrl: string }>('/api/toolbox/connect', { method: 'POST', body: '{}' });
      window.location.assign(authorizationUrl);
    } catch (e) {
      setBusy(false);
      setNotice({ ok: false, message: e instanceof ApiError ? e.message : 'Connexion à la Toolbox impossible.' });
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      setStatus(await api<ToolboxStatusView>('/api/toolbox/disconnect', { method: 'POST', body: '{}' }));
      setNotice({ ok: true, message: 'Connexion Toolbox oubliée par VIPER.' });
    } catch (e) {
      setNotice({ ok: false, message: e instanceof ApiError ? e.message : 'Déconnexion impossible.' });
    } finally { setBusy(false); }
  };
  return <ToolboxStatusPanel status={status} busy={busy} notice={notice} onConnect={connect} onDisconnect={disconnect} />;
}
