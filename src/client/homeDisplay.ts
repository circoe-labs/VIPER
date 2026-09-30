// Affichage de l'Accueil (retour « PARTIE PROSPECTION ») : tendance des réponses, camembert du mois, planning des cohortes.
// Pur et testable ; définitions des données dans `src/shared/homeDashboard.ts`.
import { prospectStateLabels } from '../shared/contactWorkflow';
import { monthOutcomeKeys, type MonthOutcomeKey, type MonthOutcomes, type ResponseTrend } from '../shared/homeDashboard';

export type TrendView = { delta: number; tone: 'up' | 'down' | 'flat'; arrow: string; label: string };

/** Flèche verte montante si plus de réponses que les 7 jours précédents, rouge descendante si moins. */
export function responseTrendView(trend: ResponseTrend): TrendView {
  const delta = trend.current - trend.previous;
  const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return { delta, tone, arrow: tone === 'up' ? '▲' : tone === 'down' ? '▼' : '▶', label: `${delta > 0 ? '+' : ''}${delta}` };
}

export const monthOutcomeLabels: Readonly<Record<MonthOutcomeKey, string>> = {
  sequence: 'Contactés / relancés', response_received: prospectStateLabels.response_received ?? 'Réponse reçue',
  appointment_obtained: prospectStateLabels.appointment_obtained ?? 'RDV pris', failure: 'Défaillants (Failure)', ignored: prospectStateLabels.ignored ?? 'Ignoré'
};
export const monthOutcomeColors: Readonly<Record<MonthOutcomeKey, string>> = {
  sequence: '#8a9893', response_received: '#56a8ff', appointment_obtained: '#3de991', failure: '#ef6b6b', ignored: '#d7b45a'
};

export type PieSegment = { key: MonthOutcomeKey; label: string; color: string; value: number; from: number; to: number };

/** Segments cumulés en pourcentage (0 à 100) ; `background` = `conic-gradient` prêt à l'emploi (gris si aucun résultat). */
export function monthPie(month: MonthOutcomes): { total: number; segments: PieSegment[]; background: string } {
  const total = monthOutcomeKeys.reduce((sum, key) => sum + (month[key] || 0), 0);
  let cursor = 0;
  const segments = monthOutcomeKeys.map(key => {
    const value = month[key] || 0;
    const from = cursor;
    cursor += total ? value / total * 100 : 0;
    return { key, label: monthOutcomeLabels[key], color: monthOutcomeColors[key], value, from, to: cursor };
  });
  const background = total
    ? `conic-gradient(${segments.filter(s => s.value).map(s => `${s.color} ${s.from.toFixed(2)}% ${s.to.toFixed(2)}%`).join(', ')})`
    : 'conic-gradient(#26312d 0 100%)';
  return { total, segments, background };
}

/** Jour de contact de chaque cohorte (lundi S37, mardi S39, mercredi S40) ; 1 = lundi … 7 = dimanche. */
export const cohortContactDays: readonly { week: number; weekday: number; day: string }[] = [
  { week: 37, weekday: 1, day: 'lundi' }, { week: 39, weekday: 2, day: 'mardi' }, { week: 40, weekday: 3, day: 'mercredi' }
];

/** Prochaine occurrence (aujourd'hui inclus) du jour de contact de chaque cohorte, en date locale. */
export function cohortSchedule(today: Date): { week: number; day: string; date: Date }[] {
  const todayWeekday = ((today.getDay() + 6) % 7) + 1;
  return cohortContactDays.map(({ week, weekday, day }) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ((weekday - todayWeekday + 7) % 7), 12);
    return { week, day, date };
  });
}
