import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { prospectStates } from '../src/shared/contactWorkflow';
import {
  HISTORY_LIMIT, initialStateChoice, isStateLocked, presenceNotice, prospectSummary, selectionPresence, stateChangeConfirmation,
  stateChangeHint, stateChangeNotice, stateChangePatch, workbenchStateOptions, type ProspectDetail
} from '../src/client/contactWorkbenchModel';
import { ProspectSummary } from '../src/client/ContactWorkbench';
import { ContactMailPanel } from '../src/client/ContactMailPanel';

const detail = (over: Partial<ProspectDetail> = {}, prospect: Record<string, unknown> = {}): ProspectDetail => ({
  prospect: { id: 'p1', first_name: 'Alice', last_name: 'Martin', civility: 'Mme', exact_job_title: 'Directrice RSE', contactability_status: 'contactable', employment_verified_at: '2026-09-01', ...prospect },
  company: { display_name: 'Acme', website_url: 'https://acme.test', email_domain: 'acme.test' },
  role: 'Direction',
  emails: [
    { address: 'alice.perso@acme.test', is_primary: 0, verification_status: 'unverified' },
    { address: 'alice@acme.test', is_primary: 1, verification_status: 'verified' }
  ],
  phones: [{ number: '0102030405', type: 'mobile', is_primary: 1, verification_status: 'unverified' }],
  tracking: { status: 'contacted', next_action_year: 2026, next_action_week: 41 },
  trackingHistory: [
    { id: 'h2', to_status: 'contacted', changed_at: '2026-09-28T09:00:00Z', actor_type: 'human' },
    { id: 'h1', to_status: 'to_contact', changed_at: '2026-09-01T09:00:00Z', actor_type: 'system' }
  ],
  ...over
});
const noWeek = { year: null, week: null };
const s41 = { year: 2026, week: 41 };

describe('fiche prospect du workbench', () => {
  it('affiche identité, entreprise, fonction, coordonnées (principal en tête), état + semaine et historique', () => {
    const s = prospectSummary(detail());
    expect(s).toMatchObject({ id: 'p1', name: 'Alice Martin', civility: 'Mme', jobTitle: 'Directrice RSE', role: 'Direction', doNotContact: null });
    expect(s.company).toEqual({ name: 'Acme', website: 'https://acme.test', domain: 'acme.test' });
    expect(s.emails.map(e => [e.address, e.primary, e.verification])).toEqual([['alice@acme.test', true, 'Vérifié'], ['alice.perso@acme.test', false, 'À vérifier']]);
    expect(s.phones[0]).toMatchObject({ number: '0102030405', type: 'Mobile', primary: true });
    expect(s.tracking).toEqual({ status: 'contacted', year: 2026, week: 41, stateSince: '2026-09-28T09:00:00Z' });
    expect(s.history.map(h => [h.label, h.by])).toEqual([['Contacté', 'Manuel'], ['Aucun état (ancien suivi)', 'Système']]);
  });

  it('gère les données absentes sans inventer de valeur', () => {
    const s = prospectSummary(detail({ company: null, role: null, emails: [], phones: [], tracking: null, trackingHistory: [] }, { first_name: '', last_name: '', exact_job_title: null, civility: null }));
    expect(s).toMatchObject({ name: 'Nom non renseigné', jobTitle: null, role: null, company: null, emails: [], phones: [], history: [] });
    expect(s.tracking).toEqual({ status: 'neutral', year: null, week: null, stateSince: null });
  });

  it('signale le blocage durable et limite l’historique', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, to_status: 'r1', changed_at: '2026-09-01', actor_type: 'human' }));
    const s = prospectSummary(detail({ trackingHistory: history }, { contactability_status: 'do_not_contact', do_not_contact_reason: 'Demande écrite' }));
    expect(s.doNotContact).toEqual({ reason: 'Demande écrite' });
    expect(s.history).toHaveLength(HISTORY_LIMIT);
  });

  it('la fiche est en lecture seule : aucun champ éditable du prospect', () => {
    const markup = renderToStaticMarkup(createElement(ProspectSummary, { summary: prospectSummary(detail()) }));
    expect(markup).toContain('Acme');
    expect(markup).toContain('alice@acme.test');
    expect(markup).not.toMatch(/<(input|textarea|select)\b/);
  });

  it('la zone mail charge la séquence sans inventer de message ni de bouton « générer »', () => {
    const markup = renderToStaticMarkup(createElement(ContactMailPanel, { prospect: prospectSummary(detail()), onTrackingChanged: () => undefined }));
    expect(markup).toContain('Séquence mail');
    expect(markup).toContain('Chargement des messages');
    expect(markup).not.toMatch(/générer/i);
  });
});

describe('choix manuel de l’état', () => {
  it('propose les 8 états du contrat, `ignored` verrouille', () => {
    expect(workbenchStateOptions.map(o => o.value)).toEqual([...prospectStates]);
    expect(workbenchStateOptions[0].label).toBe('Aucun état');
    expect(isStateLocked('ignored')).toBe(true);
    for (const state of prospectStates.filter(s => s !== 'ignored')) expect(isStateLocked(state)).toBe(false);
    expect(initialStateChoice('follow_up_1', false)).toBe('r1');
    expect(initialStateChoice('bizarre', false)).toBeNull();
    expect(stateChangePatch('r1')).toEqual({ status: 'r1' });
  });

  it('confirme seulement les états qui annulent la séquence, sans prétendre qu’un message existe', () => {
    for (const to of prospectStates) {
      const c = stateChangeConfirmation('contacted', to, noWeek);
      expect(c !== null).toBe(['response_received', 'appointment_obtained', 'ignored'].includes(to));
      if (c) {
        expect(c.lines[0]).toContain('messages futurs non envoyés');
        expect(c.lines[0]).toContain('s’il y en a');
      }
    }
    expect(stateChangeConfirmation('response_received', 'response_received', noWeek)).toBeNull();
  });

  it('précise le retrait de la semaine et le caractère définitif de « Ignoré »', () => {
    const response = stateChangeConfirmation('r1', 'response_received', s41)!;
    expect(response.lines).toContain('La prochaine semaine (S41 2026) sera retirée.');
    expect(response.lines.join(' ')).not.toContain('définitif');
    const ignored = stateChangeConfirmation('neutral', 'ignored', noWeek)!;
    expect(ignored.lines.join(' ')).toContain('définitif');
    expect(ignored.confirmLabel).toContain('définitif');
    expect(ignored.lines.join(' ')).not.toContain('semaine');
  });

  it('indique qu’un état sans échéance (Failure) retire la semaine, sans confirmation', () => {
    expect(stateChangeConfirmation('r2', 'failure', s41)).toBeNull();
    expect(stateChangeHint('r2', 'failure', s41)).toContain('retire la prochaine semaine');
    expect(stateChangeHint('r2', 'failure', noWeek)).toBeNull();
    expect(stateChangeHint('contacted', 'r1', s41)).toBeNull();
    expect(stateChangeHint('contacted', 'ignored', s41)).toBeNull(); // déjà dit dans la confirmation
  });

  it('annonce le résultat renvoyé par le service', () => {
    const base = { stateChanged: true, doNotContactReinforced: false, cancelledMessages: 0 };
    expect(stateChangeNotice({ ...base, tracking: { status: 'r1', next_action_year: 2026, next_action_week: 41 } }, s41)).toBe('État enregistré : R1.');
    expect(stateChangeNotice({ ...base, tracking: { status: 'response_received', next_action_year: null, next_action_week: null } }, s41))
      .toBe('État enregistré : Réponse reçue. Prochaine semaine retirée.');
    expect(stateChangeNotice({ ...base, doNotContactReinforced: true, cancelledMessages: 2, tracking: { status: 'ignored' } }, noWeek))
      .toBe('État enregistré : Ignoré. 2 messages futurs annulés. Prospect marqué « À ne plus contacter ».');
  });
});

describe('sélection stable après rafraîchissement', () => {
  it('garde la fiche ouverte quand le prospect sort de la liste', () => {
    expect(selectionPresence(null, ['a'], false)).toBe('none');
    expect(selectionPresence('a', ['a', 'b'], true)).toBe('listed');
    expect(selectionPresence('c', ['a'], true)).toBe('pending');
    expect(selectionPresence('c', ['a'], false)).toBe('outside_list');
  });

  it('explique pourquoi le prospect n’est plus listé', () => {
    expect(presenceNotice('listed', 'r1')).toBeNull();
    expect(presenceNotice('pending', 'r1')).toBeNull();
    expect(presenceNotice('outside_list', 'r1')).toContain('ne correspond plus aux filtres');
    expect(presenceNotice('outside_list', 'ignored')).toContain('ne figure plus dans Contact');
  });
});
