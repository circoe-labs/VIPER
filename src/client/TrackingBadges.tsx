// Badges de suivi réutilisables (Prospection, puis Contact) : affichage seul, aucune décision de workflow.
import React from 'react';
import { stateBadgeModel, weekBadgeModel } from './trackingDisplay';

/** Badge d'état ; ne rend rien pour `neutral` / suivi absent. */
export function StateBadge({ status }: { status: unknown }) {
  const badge = stateBadgeModel(status);
  if (!badge) return null;
  return <span className={`state-badge ${badge.tone}`} title={badge.title}><span className="sr-only">État : </span>{badge.label}</span>;
}

/** Badge de prochaine semaine (`S40`), visuellement distinct de l'état ; année en infobulle et pour les lecteurs d'écran. */
export function WeekBadge({ year, week }: { year: unknown; week: unknown }) {
  const badge = weekBadgeModel(year, week);
  if (!badge) return null;
  return <span className="week-badge" title={badge.title}><span className="sr-only">{badge.title} : </span><span aria-hidden="true">{badge.label}</span></span>;
}

/** État + semaine côte à côte, indépendants ; `empty` s'affiche seulement si aucun des deux n'existe. */
export function TrackingBadges({ status, year, week, empty = null }: { status: unknown; year: unknown; week: unknown; empty?: React.ReactNode }) {
  const hasState = stateBadgeModel(status) !== null;
  const hasWeek = weekBadgeModel(year, week) !== null;
  if (!hasState && !hasWeek) return <>{empty}</>;
  return <span className="tracking-badges"><StateBadge status={status} /><WeekBadge year={year} week={week} /></span>;
}
