import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../src/server/schema.js';
import { CONTACT_MESSAGES_MIGRATION_ID, migrateContactMessages } from '../src/server/contactMessageSchema.js';
import {
  appendContactMessageEvent, cancelFutureContactMessages, contactMessageCanceller, createContactMessage, getContactMessage,
  getContactMessageById, listContactMessageEvents, listContactMessages
} from '../src/server/contactMessageStore.js';
import { createContactTrackingService } from '../src/server/contactTrackingService.js';
import {
  canTransitionContactMessage, contactMessageStatuses, contactMessageStatusLabels, contactMessageSteps, isContactMessageStatus, prospectStates
} from '../src/shared/contactWorkflow.js';

const human = { type: 'human' as const, id: 'pilot-user', display: 'Commercial VIPER' };
const dispatcher = { type: 'system' as const, id: 'dispatcher' };
const AT = '2026-09-29T08:00:00.000Z';
const LATER = '2026-10-05T07:30:00.000Z';

function openDb(migrate = true) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  if (migrate) migrateContactMessages(db);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  return db;
}
const addProspect = (db: Database.Database, id: string) =>
  db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name) VALUES(?,'c1','P','Test')").run(id);
const draft = (db: Database.Database, prospectId: string, step: 'contact' | 'r1' | 'r2' = 'contact') =>
  createContactMessage(db, { prospectId, step, actor: human, at: AT, subject: 'Objet', bodyText: 'Corps', to: ['p@example.test'], fromEmail: 'from@example.test' });
const set = (db: Database.Database, id: string, sql: string, params: unknown[] = []) =>
  db.prepare(`UPDATE contact_messages SET ${sql} WHERE id=?`).run(...params, id);
// Transitions « brutes » (la machine d'état complète est la Task 12) pour placer une ligne dans un statut valide.
const validate = (db: Database.Database, id: string) => set(db, id, "status='validated',validated_at=?,validated_by_actor_id='pilot-user',validated_revision=revision", [AT]);
const schedule = (db: Database.Database, id: string) => { validate(db, id); set(db, id, "status='scheduled',scheduled_at=?", [LATER]); };
const markSent = (db: Database.Database, id: string) => { schedule(db, id); set(db, id, "status='sent',sent_at=?,remote_message_id='remote-msg-1'", [LATER]); };
const status = (db: Database.Database, id: string) => getContactMessageById(db, id)?.status;
const rowCount = (db: Database.Database, table: string) => Number((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);

describe('contrat partagé des statuts message', () => {
  it('cinq statuts distincts des états prospect, labels FR sans jargon', () => {
    expect(contactMessageStatuses).toEqual(['draft', 'validated', 'scheduled', 'sent', 'cancelled']);
    expect(Object.values(contactMessageStatusLabels)).toEqual(['Brouillon', 'Validé', 'Programmé', 'Envoyé', 'Annulé']);
    expect(contactMessageStatuses.filter(s => (prospectStates as readonly string[]).includes(s))).toEqual([]);
    expect(isContactMessageStatus('neutral')).toBe(false);
  });

  it('transitions du contrat : draft ne va jamais directement à scheduled/sent, sent et cancelled sans sortie', () => {
    expect(canTransitionContactMessage('draft', 'validated')).toBe(true);
    expect(canTransitionContactMessage('draft', 'scheduled')).toBe(false);
    expect(canTransitionContactMessage('draft', 'sent')).toBe(false);
    expect(canTransitionContactMessage('validated', 'draft')).toBe(true);
    expect(canTransitionContactMessage('scheduled', 'sent')).toBe(true);
    for (const to of contactMessageStatuses) {
      expect(canTransitionContactMessage('sent', to)).toBe(false);
      expect(canTransitionContactMessage('cancelled', to)).toBe(false);
    }
  });
});

describe('migration contact_messages', () => {
  it('base neuve : crée les tables, index et trigger, rapport non-PII, une seule fois', () => {
    const db = openDb(false);
    const report = migrateContactMessages(db);
    expect(report).toEqual({
      id: CONTACT_MESSAGES_MIGRATION_ID, existingTables: [], messageRows: 0, eventRows: 0,
      createdTables: ['contact_messages', 'contact_message_events', 'contact_message_remote_draft_cleanups']
    });
    expect(migrateContactMessages(db)).toBeNull();
    expect(rowCount(db, 'schema_migrations')).toBe(1);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%contact_message%'").all() as { name: string }[]).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(['ix_contact_messages_due', 'ux_contact_messages_remote_draft', 'ux_contact_messages_dispatch_claim',
      'ix_contact_message_events_message', 'ix_contact_message_remote_draft_cleanups_pending', 'trg_contact_messages_sent_immutable']));
  });

  it('base existante (migrations précédentes appliquées, données) : additive, données intactes, index recréés si supprimés', () => {
    const db = openDb(false);
    addProspect(db, 'p1');
    db.prepare("INSERT INTO contact_tracking(id,prospect_id,status) VALUES('t1','p1','contacted')").run();
    db.prepare("INSERT INTO schema_migrations(id) VALUES('2026-09-contact-02-next-action')").run();
    migrateContactMessages(db);
    expect(db.prepare("SELECT status FROM contact_tracking WHERE id='t1'").get()).toEqual({ status: 'contacted' });
    db.exec('DROP INDEX ix_contact_messages_due');
    expect(migrateContactMessages(db)).toBeNull();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ix_contact_messages_due'").get()).toBeTruthy();
  });

  it('table préexistante incomplète : migration annulée (rollback), rien d’enregistré', () => {
    const db = openDb(false);
    db.exec('CREATE TABLE contact_messages(id TEXT PRIMARY KEY,prospect_id TEXT NOT NULL)');
    expect(() => migrateContactMessages(db)).toThrow(/colonnes absentes dans contact_messages/);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(CONTACT_MESSAGES_MIGRATION_ID)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='contact_message_events'").get()).toBeUndefined();
  });

  it('restauration : une sauvegarde sérialisée conserve messages, programmation et id distant, migration non rejouée', () => {
    const db = openDb();
    addProspect(db, 'p1');
    const message = draft(db, 'p1');
    schedule(db, message.id);
    set(db, message.id, "remote_provider='infomaniak',remote_draft_id='remote-draft-1'");
    const restored = new Database(db.serialize());
    restored.pragma('foreign_keys = ON');
    restored.exec(schema);
    expect(migrateContactMessages(restored)).toBeNull();
    expect(getContactMessage(restored, 'p1', 'contact')).toMatchObject({ status: 'scheduled', scheduled_at: LATER, remote_draft_id: 'remote-draft-1', to_recipients: ['p@example.test'] });
    expect(listContactMessageEvents(restored, message.id).map(e => e.event_type)).toEqual(['created']);
  });
});

describe('repository contact_messages', () => {
  it('crée Contact, R1 et R2 en brouillon, listés dans l’ordre des étapes, séparés de la table drafts', () => {
    const db = openDb();
    addProspect(db, 'p1');
    for (const step of ['r2', 'contact', 'r1'] as const) draft(db, 'p1', step);
    const messages = listContactMessages(db, 'p1');
    expect(messages.map(m => [m.step, m.status, m.revision])).toEqual(contactMessageSteps.map(step => [step, 'draft', 1]));
    expect(messages[0]).toMatchObject({ subject: 'Objet', body_text: 'Corps', to_recipients: ['p@example.test'], cc_recipients: [], from_email: 'from@example.test', validated_at: null });
    expect(rowCount(db, 'drafts')).toBe(0);
  });

  it('génération IA tracée sans contenu ; création = événement generated', () => {
    const db = openDb();
    addProspect(db, 'p1');
    const message = createContactMessage(db, { prospectId: 'p1', step: 'contact', actor: human, at: AT, subject: 'Secret', bodyText: 'Texte', generation: { model: 'model-x', promptVersion: 'v1' } });
    expect(message).toMatchObject({ generation_model: 'model-x', generation_prompt_version: 'v1', status: 'draft' });
    const [event] = listContactMessageEvents(db, message.id);
    expect(event).toMatchObject({ event_type: 'generated', to_status: 'draft', revision: 1, actor_type: 'human', details: { step: 'contact', model: 'model-x', prompt_version: 'v1' } });
    const stored = JSON.stringify(db.prepare('SELECT * FROM contact_message_events').all());
    expect(stored).not.toMatch(/Secret|Texte|example\.test/);
  });

  it('refuse sujet, corps ou destinataires dans les détails d’un événement', () => {
    const db = openDb();
    addProspect(db, 'p1');
    const message = draft(db, 'p1');
    for (const key of ['subject', 'body_text', 'to', 'cc_recipients', 'from_email']) {
      expect(() => appendContactMessageEvent(db, { messageId: message.id, type: 'edited', actor: human, at: AT, details: { [key]: 'x' } })).toThrow(/refusé/);
    }
    appendContactMessageEvent(db, { messageId: message.id, type: 'send_failed', actor: dispatcher, at: AT, details: { error_code: 'toolbox_timeout', retryable: true } });
    expect(listContactMessageEvents(db, message.id).map(e => e.event_type)).toEqual(['created', 'send_failed']);
  });
});

describe('contraintes SQL contact_messages', () => {
  const insert = (db: Database.Database, values: Record<string, unknown>) => {
    const row = { id: 'm-raw', prospect_id: 'p1', step: 'contact', status: 'draft', created_at: AT, updated_at: AT, ...values };
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO contact_messages(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  const setup = () => { const db = openDb(); addProspect(db, 'p1'); return db; };

  it('step et status invalides refusés', () => {
    const db = setup();
    expect(() => insert(db, { step: 'r3' })).toThrow(/CHECK/);
    expect(() => insert(db, { status: 'neutral' })).toThrow(/CHECK/);
    expect(() => insert(db, { status: 'contacted' })).toThrow(/CHECK/);
  });

  it('un message par prospect et par étape ; prospect inconnu refusé', () => {
    const db = setup();
    draft(db, 'p1', 'contact');
    expect(() => draft(db, 'p1', 'contact')).toThrow(/UNIQUE/);
    expect(listContactMessageEvents(db, getContactMessage(db, 'p1', 'contact')!.id)).toHaveLength(1);
    expect(() => draft(db, 'nobody', 'contact')).toThrow(/FOREIGN KEY/);
  });

  it('scheduled sans scheduled_at, sent sans sent_at, cancelled sans cancelled_at refusés', () => {
    const db = setup();
    const valid = { validated_at: AT, validated_by_actor_id: 'u1', validated_revision: 1 };
    expect(() => insert(db, { ...valid, status: 'scheduled' })).toThrow(/CHECK/);
    expect(() => insert(db, { ...valid, status: 'scheduled', scheduled_at: 'pas une date' })).toThrow(/CHECK/);
    expect(() => insert(db, { ...valid, status: 'sent', scheduled_at: LATER })).toThrow(/CHECK/);
    expect(() => insert(db, { status: 'draft', sent_at: LATER })).toThrow(/CHECK/);
    expect(() => insert(db, { status: 'cancelled' })).toThrow(/CHECK/);
    insert(db, { ...valid, status: 'scheduled', scheduled_at: LATER });
  });

  it('validated/scheduled/sent exigent la validation humaine de la révision courante ; draft n’en porte aucune', () => {
    const db = setup();
    expect(() => insert(db, { status: 'validated' })).toThrow(/CHECK/);
    expect(() => insert(db, { status: 'sent', sent_at: LATER, scheduled_at: LATER })).toThrow(/CHECK/);
    const message = draft(db, 'p1', 'r1');
    validate(db, message.id);
    // Une édition (nouvelle révision) sans retour à draft est refusée : la validation n'est plus courante.
    expect(() => set(db, message.id, 'revision=revision+1')).toThrow(/CHECK/);
    // Retour à draft sans effacer la validation : refusé.
    expect(() => set(db, message.id, "status='draft',revision=revision+1")).toThrow(/CHECK/);
    set(db, message.id, "status='draft',revision=revision+1,validated_at=NULL,validated_by_actor_id=NULL,validated_revision=NULL");
    expect(getContactMessageById(db, message.id)).toMatchObject({ status: 'draft', revision: 2 });
  });

  it('remote draft seulement sur un message validé ; verrou de dispatch complet et seulement programmé/envoyé', () => {
    const db = setup();
    const message = draft(db, 'p1');
    expect(() => set(db, message.id, "remote_provider='infomaniak',remote_draft_id='d1'")).toThrow(/CHECK/);
    validate(db, message.id);
    expect(() => set(db, message.id, "remote_draft_id='d1'")).toThrow(/CHECK/);
    set(db, message.id, "remote_provider='infomaniak',remote_draft_id='d1'");
    expect(() => set(db, message.id, "dispatch_claim_id='claim-1',dispatch_claimed_at=?", [AT])).toThrow(/CHECK/);
    set(db, message.id, "status='scheduled',scheduled_at=?", [LATER]);
    expect(() => set(db, message.id, "dispatch_claim_id='claim-1'")).toThrow(/CHECK/);
    set(db, message.id, "dispatch_claim_id='claim-1',dispatch_claimed_at=?,dispatch_attempts=1", [AT]);
    expect(() => set(db, message.id, "last_error_code='toolbox_timeout'")).toThrow(/CHECK/);
    expect(() => set(db, message.id, 'dispatch_attempts=-1')).toThrow(/CHECK/);
    // Deux messages ne peuvent partager ni un brouillon distant ni une clé d'idempotence.
    const other = draft(db, 'p1', 'r1');
    schedule(db, other.id);
    expect(() => set(db, other.id, "remote_provider='infomaniak',remote_draft_id='d1'")).toThrow(/UNIQUE/);
    expect(() => set(db, other.id, "dispatch_claim_id='claim-1',dispatch_claimed_at=?", [AT])).toThrow(/UNIQUE/);
  });

  it('destinataires : tableau JSON obligatoire', () => {
    const db = setup();
    expect(() => insert(db, { to_recipients_json: 'p@example.test' })).toThrow(/CHECK/);
    expect(() => insert(db, { cc_recipients_json: '{}' })).toThrow(/CHECK/);
  });

  it('un message envoyé est immuable', () => {
    const db = setup();
    const message = draft(db, 'p1');
    markSent(db, message.id);
    expect(() => set(db, message.id, "subject='Autre'")).toThrow(/contact_message_sent_immutable/);
    expect(() => set(db, message.id, "status='cancelled',cancelled_at=?", [AT])).toThrow(/contact_message_sent_immutable/);
    expect(getContactMessageById(db, message.id)).toMatchObject({ status: 'sent', subject: 'Objet', remote_message_id: 'remote-msg-1' });
  });

  it('suppression du prospect : messages et journal supprimés, id distant en file conservé', () => {
    const db = setup();
    addProspect(db, 'p2');
    const message = draft(db, 'p1');
    markSent(db, draft(db, 'p1', 'r1').id);
    draft(db, 'p2');
    db.prepare("INSERT INTO contact_message_remote_draft_cleanups(id,message_id,remote_provider,remote_draft_id,reason,created_at) VALUES('q1',?,'infomaniak','d-old','edited',?)").run(message.id, AT);
    db.prepare("DELETE FROM prospects WHERE id='p1'").run();
    expect(listContactMessages(db, 'p1')).toEqual([]);
    expect(Number((db.prepare("SELECT count(*) n FROM contact_message_events WHERE message_id=?").get(message.id) as { n: number }).n)).toBe(0);
    expect(listContactMessages(db, 'p2')).toHaveLength(1);
    expect(db.prepare("SELECT message_id,remote_draft_id FROM contact_message_remote_draft_cleanups WHERE id='q1'").get()).toEqual({ message_id: null, remote_draft_id: 'd-old' });
  });
});

describe('annulation des messages futurs (décision 29)', () => {
  function sequence() {
    const db = openDb();
    addProspect(db, 'p1');
    addProspect(db, 'p2');
    const contact = draft(db, 'p1', 'contact');
    const r1 = draft(db, 'p1', 'r1');
    const r2 = draft(db, 'p1', 'r2');
    const other = draft(db, 'p2', 'contact');
    markSent(db, contact.id);
    schedule(db, r1.id);
    set(db, r1.id, "remote_provider='infomaniak',remote_draft_id='remote-r1'");
    return { db, contact, r1, r2, other };
  }

  it('annule draft/validated/scheduled, laisse sent intact, met le brouillon distant en file, journalise sans contenu', () => {
    const { db, contact, r1, r2, other } = sequence();
    const result = cancelFutureContactMessages(db, { prospectId: 'p1', reason: 'prospect_state:response_received', actor: human, at: LATER });
    expect(result).toEqual({ cancelled: 2, cancelledIds: [r1.id, r2.id], inFlight: 0, remoteDraftsQueued: 1 });
    expect(getContactMessageById(db, contact.id)).toMatchObject({ status: 'sent', cancelled_at: null });
    expect(getContactMessageById(db, r1.id)).toMatchObject({ status: 'cancelled', cancelled_at: LATER, cancel_reason: 'prospect_state:response_received', remote_draft_id: null, scheduled_at: LATER });
    expect(status(db, r2.id)).toBe('cancelled');
    expect(status(db, other.id)).toBe('draft');
    expect(db.prepare('SELECT message_id,remote_provider,remote_draft_id,reason,completed_at FROM contact_message_remote_draft_cleanups').all())
      .toEqual([{ message_id: r1.id, remote_provider: 'infomaniak', remote_draft_id: 'remote-r1', reason: 'cancelled', completed_at: null }]);
    expect(listContactMessageEvents(db, r1.id).at(-1)).toMatchObject({ event_type: 'cancelled', from_status: 'scheduled', to_status: 'cancelled', details: { reason: 'prospect_state:response_received', remote_draft_queued: true } });
    expect(listContactMessageEvents(db, contact.id).map(e => e.event_type)).toEqual(['created']);
    // Idempotent : un second appel n'annule rien de plus.
    expect(cancelFutureContactMessages(db, { prospectId: 'p1', reason: 'x', actor: human, at: LATER }).cancelled).toBe(0);
  });

  it('un envoi verrouillé en cours n’est pas annulé : laissé au dispatcher', () => {
    const { db, r1, r2 } = sequence();
    set(db, r1.id, "dispatch_claim_id='claim-1',dispatch_claimed_at=?", [LATER]);
    expect(cancelFutureContactMessages(db, { prospectId: 'p1', reason: 'r', actor: human, at: LATER })).toMatchObject({ cancelled: 1, cancelledIds: [r2.id], inFlight: 1, remoteDraftsQueued: 0 });
    expect(status(db, r1.id)).toBe('scheduled');
  });

  it('branché sur le service de suivi : réponse reçue annule dans la même transaction, contacté n’annule rien', () => {
    const { db, contact, r1, r2 } = sequence();
    const service = createContactTrackingService(db, { cancelFutureMessages: contactMessageCanceller, now: () => new Date(LATER) });
    service.applyProspectPayload('p1', {}, human);
    expect(service.changeState('p1', 'contacted', human).cancelledMessages).toBe(0);
    expect(status(db, r1.id)).toBe('scheduled');
    const result = service.changeState('p1', 'response_received', human);
    expect(result.cancelledMessages).toBe(2);
    expect([status(db, contact.id), status(db, r1.id), status(db, r2.id)]).toEqual(['sent', 'cancelled', 'cancelled']);
    expect(getContactMessageById(db, r2.id)?.cancel_reason).toBe('prospect_state:response_received');
  });

  it('une erreur d’annulation annule aussi le changement d’état', () => {
    const { db, r2 } = sequence();
    const service = createContactTrackingService(db, { cancelFutureMessages: contactMessageCanceller, now: () => new Date(LATER) });
    service.applyProspectPayload('p1', {}, human);
    db.exec("CREATE TRIGGER fail_cancel BEFORE UPDATE ON contact_messages WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'boom'); END");
    expect(() => service.changeState('p1', 'ignored', human)).toThrow(/boom/);
    expect(service.getTracking('p1')?.status).toBe('neutral');
    expect(status(db, r2.id)).toBe('draft');
  });
});
