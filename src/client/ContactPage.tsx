// Page Contact (Task 08, décisions 15/16/19) : coquille reprenant le langage visuel de Prospection, sans métrique ni donnée.
// Points de branchement :
// - Task 09 : sélecteur de semaine + cartes-filtres (« à traiter cette semaine », « RDV pris ») dans `dashboard`,
//   liste des prospects de la semaine dans `list`.
// - Task 10 : split view fiche prospect (gauche) / séquence mail (droite) dans `main`.
import React, { type ReactNode } from 'react';
import { PageTitle } from './PageTitle';

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

export function ContactPage({ onPlanInProspection }: { onPlanInProspection: () => void }) {
  return <ContactWorkspace
    list={<div className="empty-list">
      <p>Les prospects à traiter apparaîtront ici, par semaine de prochaine action.</p>
      <button className="secondary" onClick={onPlanInProspection}>Planifier depuis Prospection</button>
    </div>}
    main={<div className="empty-list contact-main-empty">Aucun prospect sélectionné.</div>}
  />;
}
