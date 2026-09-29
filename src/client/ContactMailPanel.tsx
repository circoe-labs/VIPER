// Zone mail du workbench Contact (Task 10) : emplacement réservé à la séquence Contact/R1/R2 (décision 20).
// Task 13 remplace le contenu de ce composant par l'éditeur (onglets, destinataires, objet, corps, validation, programmation) ;
// ses props restent le point d'entrée. Aucun message n'est inventé ni généré ici (l'IA n'existe pas encore : Task 14).
import React from 'react';
import type { ProspectSummaryModel } from './contactWorkbenchModel';

export type ContactMailPanelProps = {
  /** Fiche du prospect sélectionné (lecture seule) : destinataire principal = premier email (principal en tête). */
  prospect: ProspectSummaryModel;
  /** À appeler par l'éditeur après une mutation qui touche le suivi (le workbench recharge la fiche, la page la liste). */
  onTrackingChanged: () => void;
};

export function ContactMailPanel({ prospect }: ContactMailPanelProps) {
  const recipient = prospect.emails[0]?.address ?? null;
  return <div className="contact-mail-placeholder">
    <h3 id={`contact-mail-title-${prospect.id}`}>Séquence mail</h3>
    <p className="muted">Destinataire principal : {recipient ?? 'aucun email renseigné (à compléter dans la fiche Prospection)'}</p>
    <div className="empty-list">
      <p>L’éditeur des messages Contact, R1 et R2 prendra place ici.</p>
      <p className="muted">Aucun message n’est encore préparé dans VIPER pour ce prospect.</p>
    </div>
  </div>;
}
