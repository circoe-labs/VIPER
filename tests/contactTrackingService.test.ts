import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../src/server/schema.js';
import {
  ContactTrackingError, createContactTrackingService, parseTrackingPatch, type ContactTrackingDeps, type FutureMessageCanceller
} from '../src/server/contactTrackingService.js';
import { isoWeekMonday, prospectStates, type IsoWeek, type ProspectState } from '../src/shared/contactWorkflow.js';

const human = { type: 'human' as const, id: 'pilot-user', display: 'Commercial VIPER' };
const importer = { type: 'import' as const, id: 'batch-1' };
const S = (week: number, year = 2026): IsoWeek => ({ year, week });

function setup(deps: ContactTrackingDeps = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  let clock = isoWeekMonday(S(40));
  const service = createContactTrackingService(db, { now: () => clock, ...deps });
  const addProspect = (id: string, dnc = false) =>
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,contactability_status) VALUES(?,'c1','P','Test',?)").run(id, dnc ? 'do_not_contact' : 'contactable');
  const create = (id: string, dnc = false) => { addProspect(id, dnc); service.applyProspectPayload(id, {}, human); };
  const historyCount = (id: string) => service.getHistory(id).length;
  const auditCount = (id: string) => Number((db.prepare('SELECT count(*) n FROM audit_log WHERE entity_id=?').get(id) as { n: number }).n);
  const contactability = (id: string) => (db.prepare('SELECT contactability_status c FROM prospects WHERE id=?').get(id) as { c: string }).c;
  const setClock = (week: IsoWeek) => { clock = isoWeekMonday(week); };
  return { db, service, addProspect, create, historyCount, auditCount, contactability, setClock };
}

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(ContactTrackingError);
    expect((e as ContactTrackingError).code).toBe(code);
    return;
  }
  throw new Error(`ContactTrackingError ${code} attendue`);
};

describe('service de suivi manuel — états prospects', () => {
  it('un nouveau prospect est neutral, sans semaine, avec une seule ligne d’historique', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_year: null, next_action_week: null });
    expect(historyCount('p1')).toBe(1);
    expect(service.getHistory('p1')[0]).toMatchObject({ from_status: null, to_status: 'neutral', actor_type: 'human', actor_id: 'pilot-user' });
  });

  it.each(prospectStates.filter(s => s !== 'neutral'))('changement manuel vers %s : historique et audit écrits une seule fois', state => {
    const { service, create, historyCount, auditCount } = setup();
    create('p1');
    const audits = auditCount('p1');
    const result = service.changeState('p1', state, human);
    expect(result).toMatchObject({ stateChanged: true, previousStatus: 'neutral', changed: expect.arrayContaining(['status']) });
    expect(service.getTracking('p1')?.status).toBe(state);
    expect(historyCount('p1')).toBe(2);
    expect(service.getHistory('p1')[0]).toMatchObject({ from_status: 'neutral', to_status: state, actor_type: 'human', actor_id: 'pilot-user' });
    // `ignored` ajoute l'audit du renforcement do_not_contact.
    expect(auditCount('p1')).toBe(audits + (state === 'ignored' ? 2 : 1));
    // Rechoisir le même état ne réécrit rien.
    expect(service.changeState('p1', state, human)).toMatchObject({ stateChanged: false, changed: [] });
    expect(historyCount('p1')).toBe(2);
    expect(auditCount('p1')).toBe(audits + (state === 'ignored' ? 2 : 1));
  });

  it('les transitions sont libres entre états non terminaux (choix humain), y compris retour à neutral', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    for (const state of ['r2', 'contacted', 'failure', 'r1', 'neutral'] as ProspectState[]) service.changeState('p1', state, human);
    expect(service.getTracking('p1')?.status).toBe('neutral');
    expect(historyCount('p1')).toBe(6);
  });

  it('exige un acteur humain authentifié pour les mutations publiques', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    expectCode(() => service.changeState('p1', 'contacted', importer), 'human_actor_required');
    expectCode(() => service.setNextActionWeek('p1', S(40), { type: 'human' }), 'human_actor_required');
    expectCode(() => service.updateTracking('p1', { state: 'r1' }, { type: 'system', id: 'job' }), 'human_actor_required');
    expect(service.getTracking('p1')?.status).toBe('neutral');
    expect(historyCount('p1')).toBe(1);
  });

  it('prospect inexistant : erreur 404 typée', () => {
    const { service } = setup();
    expectCode(() => service.getTracking('nope'), 'prospect_not_found');
    expectCode(() => service.changeState('nope', 'r1', human), 'prospect_not_found');
    try { service.getHistory('nope'); } catch (e) { expect((e as ContactTrackingError).httpStatus).toBe(404); }
  });
});

describe('service de suivi manuel — prochaine semaine indépendante de l’état', () => {
  it('planifier, modifier et effacer la semaine ne change jamais l’état ni l’historique', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    expect(service.setNextActionWeek('p1', S(40), human)).toMatchObject({ stateChanged: false, changed: ['next_action'] });
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_year: 2026, next_action_week: 40 });
    service.setNextActionWeek('p1', S(41), human);
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_week: 41 });
    service.setNextActionWeek('p1', S(1, 2027), human); // changement d'année
    expect(service.getTracking('p1')).toMatchObject({ next_action_year: 2027, next_action_week: 1 });
    service.setNextActionWeek('p1', null, human);
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_year: null, next_action_week: null });
    expect(historyCount('p1')).toBe(1);
  });

  it('un état de séquence conserve la semaine ; un état sans échéance par défaut l’efface', () => {
    const { service, create } = setup();
    create('p1');
    service.updateTracking('p1', { nextAction: S(40) }, human);
    service.changeState('p1', 'contacted', human);
    expect(service.getTracking('p1')).toMatchObject({ status: 'contacted', next_action_week: 40 });
    for (const state of ['response_received', 'appointment_obtained', 'failure'] as ProspectState[]) {
      service.updateTracking('p1', { state: 'r1', nextAction: S(44) }, human);
      service.changeState('p1', state, human);
      expect(service.getTracking('p1')).toMatchObject({ status: state, next_action_year: null, next_action_week: null });
      // Un humain peut reposer explicitement une semaine sur ces états.
      service.setNextActionWeek('p1', S(45), human);
      expect(service.getTracking('p1')).toMatchObject({ status: state, next_action_week: 45 });
    }
  });

  it('état + semaine dans une même mutation : un seul historique, semaine appliquée', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    const result = service.updateTracking('p1', { state: 'contacted', nextAction: S(42) }, human);
    expect(result.changed).toEqual(['status', 'next_action']);
    expect(service.getTracking('p1')).toMatchObject({ status: 'contacted', next_action_week: 42 });
    expect(historyCount('p1')).toBe(2);
  });

  it('response_received horodate la réponse une seule fois', () => {
    const { service, create } = setup();
    create('p1');
    service.changeState('p1', 'response_received', human);
    const at = service.getTracking('p1')?.response_received_at;
    expect(at).toBe(isoWeekMonday(S(40)).toISOString());
    service.changeState('p1', 'appointment_obtained', human);
    service.changeState('p1', 'response_received', human);
    expect(service.getTracking('p1')?.response_received_at).toBe(at);
  });
});

describe('service de suivi manuel — validation', () => {
  it('parse le PATCH : codes du contrat, couple ISO complet et valide, corps non vide', () => {
    expect(parseTrackingPatch({ status: 'r1' })).toEqual({ state: 'r1' });
    expect(parseTrackingPatch({ next_action_year: 2026, next_action_week: 53 })).toEqual({ nextAction: S(53) });
    expect(parseTrackingPatch({ next_action_year: null, next_action_week: null })).toEqual({ nextAction: null });
    expect(parseTrackingPatch({ status: 'contacted', next_action_year: 2026, next_action_week: 42 })).toEqual({ state: 'contacted', nextAction: S(42) });
    expectCode(() => parseTrackingPatch({ status: 'follow_up_1' }), 'invalid_state'); // legacy refusé sur la nouvelle route
    expectCode(() => parseTrackingPatch({ status: 'done' }), 'invalid_state');
    expectCode(() => parseTrackingPatch({ next_action_year: 2025, next_action_week: 53 }), 'invalid_next_action');
    expectCode(() => parseTrackingPatch({ next_action_year: 2026, next_action_week: 0 }), 'invalid_next_action');
    expectCode(() => parseTrackingPatch({ next_action_year: 2026 }), 'invalid_next_action');
    expectCode(() => parseTrackingPatch({ next_action_year: 2026, next_action_week: 40.5 }), 'invalid_payload');
    expectCode(() => parseTrackingPatch({}), 'invalid_payload');
    expectCode(() => parseTrackingPatch({ status: 'r1', response_received_at: 'x' }), 'invalid_payload');
    expectCode(() => parseTrackingPatch(null), 'invalid_payload');
  });

  it('une valeur invalide via la fiche prospect est rejetée sans rien écrire', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    expectCode(() => service.applyProspectPayload('p1', { status: 'done' }, human), 'invalid_state');
    expectCode(() => service.applyProspectPayload('p1', { next_action_year: 2025, next_action_week: 53 }, human), 'invalid_next_action');
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_week: null });
    expect(historyCount('p1')).toBe(1);
  });
});

describe('service de suivi manuel — ignored terminal et do_not_contact', () => {
  it('ignored pose do_not_contact, efface la semaine et ne peut plus être quitté', () => {
    const { service, create, contactability, historyCount } = setup();
    create('p1');
    service.updateTracking('p1', { state: 'r2', nextAction: S(48) }, human);
    const result = service.changeState('p1', 'ignored', human);
    expect(result.doNotContactReinforced).toBe(true);
    expect(contactability('p1')).toBe('do_not_contact');
    expect(service.getTracking('p1')).toMatchObject({ status: 'ignored', next_action_week: null });
    for (const state of prospectStates.filter(s => s !== 'ignored')) expectCode(() => service.changeState('p1', state, human), 'ignored_is_terminal');
    expectCode(() => service.setNextActionWeek('p1', S(50), human), 'ignored_has_no_next_action');
    expect(service.setNextActionWeek('p1', null, human).changed).toEqual([]);
    expect(historyCount('p1')).toBe(3);
  });

  it('un import ou un réimport ne réactive jamais un ignored', () => {
    const { service, create, contactability, historyCount } = setup();
    create('p1');
    service.changeState('p1', 'ignored', human);
    for (const status of ['contacted', 'to_contact', 'neutral', '']) {
      service.applyImport('p1', { status, contactYear: 2026, contactWeek: 44, importedAt: '2026-10-01T00:00:00Z' }, importer);
    }
    expect(service.getTracking('p1')).toMatchObject({ status: 'ignored', next_action_week: null });
    expect(contactability('p1')).toBe('do_not_contact');
    expect(historyCount('p1')).toBe(2);
  });

  it('la fiche prospect renvoyant l’état ignored (écho) ne déclenche aucune transition', () => {
    const { service, create, historyCount } = setup();
    create('p1');
    service.changeState('p1', 'ignored', human);
    service.applyProspectPayload('p1', { status: 'ignored', planned_contact_at: null, next_action_year: null, next_action_week: null }, human);
    expectCode(() => service.applyProspectPayload('p1', { status: 'to_contact' }, human), 'ignored_is_terminal');
    expect(historyCount('p1')).toBe(2);
  });

  it('un import créant un ignored pose do_not_contact sans semaine', () => {
    const { service, addProspect, contactability } = setup();
    addProspect('p2');
    service.applyImport('p2', { status: 'ignored', contactYear: 2026, contactWeek: 40, importedAt: '2026-10-01T00:00:00Z' }, importer);
    expect(service.getTracking('p2')).toMatchObject({ status: 'ignored', next_action_week: null });
    expect(contactability('p2')).toBe('do_not_contact');
    expect(service.getHistory('p2')[0]).toMatchObject({ actor_type: 'import', actor_id: 'batch-1' });
  });
});

describe('service de suivi manuel — annulation des messages futurs (décision 29)', () => {
  it('appelle le hook dans la transaction pour response_received, appointment_obtained et ignored uniquement', () => {
    const inTransaction: boolean[] = [];
    const cancel = vi.fn<FutureMessageCanceller>(({ db }) => { inTransaction.push(db.inTransaction); return { cancelled: 2 }; });
    const { service, create } = setup({ cancelFutureMessages: cancel });
    for (const state of prospectStates) {
      create(`p_${state}`);
      const result = service.changeState(`p_${state}`, state, human);
      const expected = ['response_received', 'appointment_obtained', 'ignored'].includes(state);
      expect(result.cancelledMessages).toBe(expected ? 2 : 0);
    }
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cancel.mock.calls.map(([c]) => c.toState)).toEqual(['response_received', 'appointment_obtained', 'ignored']);
    expect(cancel.mock.calls[0][0]).toMatchObject({ prospectId: 'p_response_received', fromState: 'neutral', actor: human });
    expect(inTransaction).toEqual([true, true, true]);
  });

  it('une erreur du hook annule aussi le changement d’état', () => {
    const { service, create, historyCount, contactability } = setup({ cancelFutureMessages: () => { throw new Error('annulation impossible'); } });
    create('p1');
    expect(() => service.changeState('p1', 'ignored', human)).toThrow('annulation impossible');
    expect(service.getTracking('p1')?.status).toBe('neutral');
    expect(contactability('p1')).toBe('contactable');
    expect(historyCount('p1')).toBe(1);
  });
});

describe('service de suivi manuel — cadence proposée, jamais appliquée', () => {
  it('Contact S40 → R1 S42 → R2 S44 → revue S48, sans changer la semaine ni l’état', () => {
    const { service, create, setClock } = setup();
    create('p1');
    service.setNextActionWeek('p1', S(40), human);
    setClock(S(40));
    expect(service.changeState('p1', 'contacted', human).suggestedNextAction).toEqual(S(42));
    expect(service.getTracking('p1')).toMatchObject({ status: 'contacted', next_action_week: 40 });
    setClock(S(42));
    expect(service.changeState('p1', 'r1', human).suggestedNextAction).toEqual(S(44));
    setClock(S(44));
    expect(service.changeState('p1', 'r2', human).suggestedNextAction).toEqual(S(48));
    expect(service.changeState('p1', 'failure', human).suggestedNextAction).toBeNull();
  });

  it('aucune transition automatique avec le temps ou une semaine échue', () => {
    const { service, create, setClock, historyCount } = setup();
    create('p1');
    service.updateTracking('p1', { state: 'r2', nextAction: S(44) }, human);
    const before = service.getTracking('p1');
    setClock(S(10, 2027)); // revue largement dépassée
    expect(service.getTracking('p1')).toEqual(before);
    service.setNextActionWeek('p1', S(9, 2027), human);
    expect(service.getTracking('p1')?.status).toBe('r2'); // jamais d'auto-passage en failure
    expect(historyCount('p1')).toBe(2);
  });
});

describe('service de suivi manuel — compatibilité fiche prospect et import', () => {
  it('fiche prospect : codes legacy convertis, alias de semaine, écho de semaine sans effet, statut inattendu toléré', () => {
    const { db, service, create, historyCount } = setup();
    create('p1');
    service.applyProspectPayload('p1', { status: 'follow_up_1', contact_year: 2026, contact_week: 44, referent_id: '' }, human);
    expect(service.getTracking('p1')).toMatchObject({ status: 'r1', next_action_week: 44, referent_id: null });
    service.applyProspectPayload('p1', { status: 'failure', next_action_year: 2026, next_action_week: 44 }, human); // écho de l'ancienne semaine
    expect(service.getTracking('p1')).toMatchObject({ status: 'failure', next_action_week: null });
    db.prepare("UPDATE contact_tracking SET status='pending_review' WHERE prospect_id='p1'").run();
    expect(service.applyProspectPayload('p1', { status: 'pending_review', planned_contact_at: '2026-10-05' }, human).changed).toEqual(['planned_contact_at']);
    expect(historyCount('p1')).toBe(3);
  });

  it('import : crée le suivi, ne fait avancer qu’un suivi neutral et ne réécrit jamais un état choisi', () => {
    const { service, addProspect, create } = setup();
    addProspect('p1');
    service.applyImport('p1', { status: 'to_contact', contactYear: 2026, contactWeek: 40, importedAt: '2026-10-01T00:00:00Z' }, importer);
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_week: 40 });
    service.applyImport('p1', { status: 'contacted', contactYear: '', contactWeek: '', importedAt: '2026-10-01T00:00:00Z' }, importer);
    expect(service.getTracking('p1')).toMatchObject({ status: 'contacted', next_action_week: 40 });
    service.applyImport('p1', { status: 'follow_up_2', contactYear: 2026, contactWeek: 46, importedAt: '2026-10-01T00:00:00Z' }, importer);
    expect(service.getTracking('p1')).toMatchObject({ status: 'contacted', next_action_week: 46 });
    create('p2');
    service.applyImport('p2', { status: 'response_received', contactYear: null, contactWeek: null, importedAt: '2026-10-01T00:00:00Z' }, importer);
    expect(service.getTracking('p2')).toMatchObject({ status: 'response_received', response_received_at: '2026-10-01T00:00:00Z' });
    expectCode(() => service.applyImport('p2', { status: 'contacted', contactYear: 2025, contactWeek: 53, importedAt: '2026-10-01T00:00:00Z' }, importer), 'invalid_next_action');
  });
});
