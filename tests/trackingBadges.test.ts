import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { prospectStates } from '../src/shared/contactWorkflow';
import { StateBadge, TrackingBadges, WeekBadge } from '../src/client/TrackingBadges';
import { historyStatusLabel, selectableState, stateBadgeModel, stateOptionLabel, weekBadgeModel } from '../src/client/trackingDisplay';

const html = (status: unknown, year: unknown, week: unknown) => renderToStaticMarkup(createElement(TrackingBadges, { status, year, week, empty: '—' }));
const visibleText = (markup: string) => markup.replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '|').split('|').filter(Boolean);

describe('badges de suivi', () => {
  it('affiche un badge par état visible et aucun pour neutral', () => {
    const expected = { neutral: null, contacted: 'Contacté', r1: 'R1', r2: 'R2', response_received: 'Réponse reçue', appointment_obtained: 'RDV pris', failure: 'Failure', ignored: 'Ignoré' };
    for (const state of prospectStates) {
      expect(stateBadgeModel(state)?.label ?? null).toBe(expected[state]);
      expect(renderToStaticMarkup(createElement(StateBadge, { status: state })) === '').toBe(state === 'neutral');
    }
    expect(stateBadgeModel(null)).toBeNull();
    expect(stateBadgeModel('')).toBeNull();
  });

  it('neutral + S40 montre S40 sans badge d’état', () => {
    const markup = html('neutral', 2026, 40);
    expect(visibleText(markup)).toEqual(['S40']);
    expect(markup).not.toContain('state-badge');
    expect(markup).toContain('2026');
  });

  it('R1 + S44 montre exactement R1 et S44, dans deux badges distincts', () => {
    const markup = html('r1', 2026, 44);
    expect(visibleText(markup)).toEqual(['R1', 'S44']);
    expect(markup).toContain('state-badge sequence');
    expect(markup).toContain('week-badge');
  });

  it('état sans semaine et semaine sans état', () => {
    expect(visibleText(html('appointment_obtained', null, null))).toEqual(['RDV pris']);
    expect(visibleText(html(null, 2027, 2))).toEqual(['S2']);
    expect(html('neutral', null, null)).toBe('—');
  });

  it('semaine : année en infobulle, couple invalide ou incomplet ignoré', () => {
    expect(weekBadgeModel(2026, 40)).toMatchObject({ label: 'S40', year: 2026, week: 40 });
    expect(weekBadgeModel(2026, 40)?.title).toContain('semaine 40 de 2026');
    expect(weekBadgeModel('2025', '53')).toBeNull(); // 2025 n'a que 52 semaines ISO
    expect(weekBadgeModel(2026, null)).toBeNull();
    expect(weekBadgeModel(null, 40)).toBeNull();
    expect(renderToStaticMarkup(createElement(WeekBadge, { year: 2020, week: 53 }))).toContain('S53');
  });

  it('aucun libellé legacy « À contacter » / « Inconnu »', () => {
    for (const state of prospectStates) expect(stateOptionLabel(state)).not.toMatch(/À contacter|Inconnu/);
    expect(stateOptionLabel('neutral')).toBe('Aucun état');
  });

  it('code hors contrat signalé tel quel (diagnostic explicite)', () => {
    expect(stateBadgeModel('mystery')).toMatchObject({ label: 'mystery', tone: 'unexpected' });
    expect(selectableState('mystery', false)).toBeNull();
  });

  it('sélecteur et historique lisent les codes legacy via le mapping du contrat', () => {
    expect(selectableState(undefined, false)).toBe('neutral');
    expect(selectableState('to_contact', false)).toBe('neutral');
    expect(selectableState('follow_up_1', false)).toBe('r1');
    expect(selectableState('not_interested', true)).toBe('ignored');
    expect(historyStatusLabel('r2', false)).toBe('R2');
    expect(historyStatusLabel('neutral', false)).toBe('Aucun état');
    expect(historyStatusLabel('to_contact', false)).toBe('Aucun état (ancien suivi)');
    expect(historyStatusLabel('quote_sent', false)).toBe('RDV pris (ancien suivi)');
    expect(historyStatusLabel('not_interested', false)).toBe('Failure (ancien suivi)');
  });
});
