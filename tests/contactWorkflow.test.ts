import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROSPECT_STATE, addIsoWeeks, cancelsFutureMessages, compareIsoWeeks, compareProspectStates, contactMessageStepLabels, contactMessageSteps,
  formatIsoWeekBadge, hasDefaultNextAction, isContactMessageStep, isProspectState, isTerminalProspectState, isValidIsoWeek, isoWeekMonday, isoWeekOf,
  isoWeekSchema, isoWeeksInYear, prospectStateBadgeLabel, prospectStateSchema, prospectStates, suggestNextActionWeek, suggestNextActionWeekAfterStep
} from '../src/shared/contactWorkflow.js';

describe('prospect states', () => {
  it('expose exactly the target taxonomy in display order', () => {
    expect(prospectStates).toEqual(['neutral', 'contacted', 'r1', 'r2', 'response_received', 'appointment_obtained', 'failure', 'ignored']);
    expect([...prospectStates].reverse().sort(compareProspectStates)).toEqual(prospectStates);
  });

  it('default state is neutral without any badge', () => {
    expect(DEFAULT_PROSPECT_STATE).toBe('neutral');
    expect(prospectStateBadgeLabel('neutral')).toBeNull();
  });

  it.each([
    ['contacted', 'Contacté'], ['r1', 'R1'], ['r2', 'R2'], ['response_received', 'Réponse reçue'],
    ['appointment_obtained', 'RDV pris'], ['failure', 'Failure'], ['ignored', 'Ignoré']
  ] as const)('%s displays %s', (state, label) => expect(prospectStateBadgeLabel(state)).toBe(label));

  it('never uses legacy labels', () => {
    const labels = prospectStates.map(prospectStateBadgeLabel);
    for (const legacy of ['Inconnu', 'Validé', 'Non validé', 'À contacter', 'Done', 'Rendez-vous obtenu']) expect(labels).not.toContain(legacy);
  });

  it('rejects legacy and unknown values', () => {
    for (const legacy of ['to_contact', 'follow_up_1', 'follow_up_2', 'quote_sent', 'quote_follow_up', 'won', 'not_interested', 'unknown', '', null, undefined, 3])
      expect(isProspectState(legacy)).toBe(false);
    expect(prospectStateSchema.safeParse('to_contact').success).toBe(false);
    for (const state of prospectStates) expect(isProspectState(state)).toBe(true);
  });

  it('classifies next action, sequence cancellation and terminal states', () => {
    expect(prospectStates.filter(hasDefaultNextAction)).toEqual(['neutral', 'contacted', 'r1', 'r2']);
    expect(prospectStates.filter(cancelsFutureMessages)).toEqual(['response_received', 'appointment_obtained', 'ignored']);
    expect(prospectStates.filter(isTerminalProspectState)).toEqual(['ignored']);
  });
});

describe('message steps', () => {
  it('are contact, r1, r2 with labels', () => {
    expect(contactMessageSteps).toEqual(['contact', 'r1', 'r2']);
    expect(contactMessageSteps.map(s => contactMessageStepLabels[s])).toEqual(['Contact', 'R1', 'R2']);
    expect(isContactMessageStep('follow_up_1')).toBe(false);
    expect(isContactMessageStep('r2')).toBe(true);
  });
});

describe('ISO weeks', () => {
  it.each([
    ['2026-09-28', 2026, 40], ['2026-01-01', 2026, 1], ['2025-12-29', 2026, 1], ['2027-01-01', 2026, 53],
    ['2027-01-03', 2026, 53], ['2027-01-04', 2027, 1], ['2021-01-03', 2020, 53], ['2024-12-30', 2025, 1]
  ])('%s is %i-W%i', (date, year, week) => expect(isoWeekOf(new Date(`${date}T12:00:00Z`))).toEqual({ year, week }));

  it('counts weeks per ISO year', () => {
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2020)).toBe(53);
  });

  it('validates weeks', () => {
    expect(isValidIsoWeek({ year: 2026, week: 53 })).toBe(true);
    expect(isValidIsoWeek({ year: 2025, week: 53 })).toBe(false);
    expect(isValidIsoWeek({ year: 2026, week: 0 })).toBe(false);
    expect(isValidIsoWeek({ year: 2026, week: 1.5 })).toBe(false);
    expect(isValidIsoWeek(null)).toBe(false);
    expect(isoWeekSchema.safeParse({ year: 2025, week: 53 }).success).toBe(false);
  });

  it('adds weeks across year boundaries', () => {
    expect(addIsoWeeks({ year: 2025, week: 52 }, 1)).toEqual({ year: 2026, week: 1 });
    expect(addIsoWeeks({ year: 2026, week: 52 }, 1)).toEqual({ year: 2026, week: 53 });
    expect(addIsoWeeks({ year: 2026, week: 53 }, 1)).toEqual({ year: 2027, week: 1 });
    expect(addIsoWeeks({ year: 2026, week: 1 }, -1)).toEqual({ year: 2025, week: 52 });
    expect(isoWeekMonday({ year: 2026, week: 1 }).toISOString().slice(0, 10)).toBe('2025-12-29');
  });

  it('compares and formats weeks', () => {
    expect(compareIsoWeeks({ year: 2025, week: 52 }, { year: 2026, week: 1 })).toBeLessThan(0);
    expect(compareIsoWeeks({ year: 2026, week: 40 }, { year: 2026, week: 40 })).toBe(0);
    expect(formatIsoWeekBadge({ year: 2026, week: 40 })).toBe('S40');
  });
});

describe('default cadence', () => {
  it('Contact S40 -> R1 S42 -> R2 S44 -> review S48', () => {
    expect(suggestNextActionWeek('contacted', { year: 2026, week: 40 })).toEqual({ year: 2026, week: 42 });
    expect(suggestNextActionWeek('r1', { year: 2026, week: 42 })).toEqual({ year: 2026, week: 44 });
    expect(suggestNextActionWeek('r2', { year: 2026, week: 44 })).toEqual({ year: 2026, week: 48 });
  });

  it('crosses S52/S53 -> S01', () => {
    expect(suggestNextActionWeekAfterStep('contact', { year: 2025, week: 51 })).toEqual({ year: 2026, week: 1 });
    expect(suggestNextActionWeekAfterStep('r1', { year: 2025, week: 52 })).toEqual({ year: 2026, week: 2 });
    expect(suggestNextActionWeekAfterStep('r2', { year: 2026, week: 52 })).toEqual({ year: 2027, week: 3 });
    expect(suggestNextActionWeekAfterStep('contact', { year: 2026, week: 52 })).toEqual({ year: 2027, week: 1 });
  });

  it('proposes nothing outside the sequence and never mutates input', () => {
    for (const state of ['neutral', 'response_received', 'appointment_obtained', 'failure', 'ignored'] as const)
      expect(suggestNextActionWeek(state, { year: 2026, week: 40 })).toBeNull();
    const from = Object.freeze({ year: 2026, week: 40 });
    const next = suggestNextActionWeek('r2', from);
    expect(from).toEqual({ year: 2026, week: 40 });
    expect(next).not.toHaveProperty('state');
  });
});
