// Schéma des messages Contact/R1/R2 (Task 11, docs/06 §4-6) : un message durable par prospect et par étape, séparé de la table
// générique `drafts` (état d'interface) et du statut prospect (`contact_tracking.status`). Migration additive (aucune table
// existante modifiée), exécutée une seule fois (`schema_migrations`) ; index et trigger recréés si absents à chaque démarrage.
//
// Intégrité exprimée en SQL (CHECK/trigger) plutôt que seulement dans le service :
// - `step`/`status`/`event_type` limités aux codes du contrat partagé (contactWorkflow.ts) ;
// - `scheduled` => `scheduled_at` ; `sent` <=> `sent_at` ; `cancelled` <=> `cancelled_at` (dates lisibles par julianday) ;
// - `validated`/`scheduled`/`sent` => validation humaine COURANTE : `validated_at`, `validated_by_actor_id` et
//   `validated_revision = revision` (une édition incrémente `revision` et doit donc repasser en `draft`) ; `draft` => aucune validation ;
// - `remote_draft_id` seulement sur un message validé/programmé/envoyé : une édition ou une annulation doit déplacer l'id distant
//   dans la file `contact_message_remote_draft_cleanups` (suppression Toolbox différée après commit, Task 16) ;
// - verrou de dispatch complet (`dispatch_claim_id` + `dispatch_claimed_at`) et seulement sur `scheduled`/`sent` ;
// - un message `sent` est immuable (trigger), la suppression du prospect supprime ses messages et leur journal (cascade).
//
// Colonnes ajoutées au modèle docs/06 §4 :
// - `revision` / `validated_revision` : la validation porte sur une révision précise ; le dispatcher (Task 16) peut vérifier
//   qu'elle est encore courante, et l'API (Task 12) s'en servir comme verrou optimiste d'édition ;
// - `remote_message_id` : identifiant renvoyé par `send_draft`, preuve d'envoi et réconciliation après redémarrage ;
// - `dispatch_claim_id` / `dispatch_claimed_at` : verrou/clé d'idempotence d'envoi (UPDATE ... WHERE status='scheduled' AND
//   dispatch_claim_id IS NULL), unique, conservé après envoi ; un verrou ancien = envoi peut-être parti, à réconcilier, jamais relancé à l'aveugle ;
// - `dispatch_attempts` / `last_error_code` / `last_error_at` : diagnostic d'envoi (code seulement, jamais de message d'erreur brut
//   pouvant contenir une adresse ; le détail non-PII va dans `contact_message_events`).
import type Database from 'better-sqlite3';
import {
  contactMessageEventTypes, contactMessageStatuses, contactMessageSteps, DEFAULT_CONTACT_MESSAGE_STATUS, validatedContactMessageStatuses
} from '../shared/contactWorkflow.js';

type Db = Database.Database;

export const CONTACT_MESSAGES_MIGRATION_ID = '2026-09-contact-11-messages';
export const remoteDraftCleanupReasons = ['edited', 'cancelled', 'replaced'] as const;
export type RemoteDraftCleanupReason = typeof remoteDraftCleanupReasons[number];
export const messageActorTypes = ['human', 'import', 'agent', 'system'] as const;

const sqlList = (values: readonly string[]) => values.map(v => `'${v.replace(/'/g, "''")}'`).join(',');
const STEPS = sqlList(contactMessageSteps);
const STATUSES = sqlList(contactMessageStatuses);
const VALIDATED = sqlList(validatedContactMessageStatuses);
const jsonArray = (column: string) => `CHECK(json_valid(${column}) AND json_type(${column})='array')`;
const isoDate = (column: string) => `CHECK(${column} IS NULL OR julianday(${column}) IS NOT NULL)`;

export const contactMessagesTableSql = `CREATE TABLE IF NOT EXISTS contact_messages(
id TEXT PRIMARY KEY,
prospect_id TEXT NOT NULL,
step TEXT NOT NULL,
status TEXT NOT NULL DEFAULT '${DEFAULT_CONTACT_MESSAGE_STATUS}',
from_email TEXT,
subject TEXT NOT NULL DEFAULT '',
body_text TEXT NOT NULL DEFAULT '',
to_recipients_json TEXT NOT NULL DEFAULT '[]',
cc_recipients_json TEXT NOT NULL DEFAULT '[]',
bcc_recipients_json TEXT NOT NULL DEFAULT '[]',
revision INTEGER NOT NULL DEFAULT 1,
scheduled_at TEXT,
validated_at TEXT,
validated_by_actor_id TEXT,
validated_revision INTEGER,
sent_at TEXT,
cancelled_at TEXT,
cancel_reason TEXT,
remote_provider TEXT,
remote_draft_id TEXT,
remote_message_id TEXT,
dispatch_claim_id TEXT,
dispatch_claimed_at TEXT,
dispatch_attempts INTEGER NOT NULL DEFAULT 0,
last_error_code TEXT,
last_error_at TEXT,
generation_model TEXT,
generation_prompt_version TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
UNIQUE(prospect_id,step),
CHECK(step IN (${STEPS})),
CHECK(status IN (${STATUSES})),
${jsonArray('to_recipients_json')},
${jsonArray('cc_recipients_json')},
${jsonArray('bcc_recipients_json')},
CHECK(revision>=1),
CHECK(dispatch_attempts>=0),
CHECK(status<>'scheduled' OR scheduled_at IS NOT NULL),
${isoDate('scheduled_at')},
CHECK((status='sent')=(sent_at IS NOT NULL)),
${isoDate('sent_at')},
CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
CHECK(status NOT IN (${VALIDATED}) OR (validated_at IS NOT NULL AND validated_by_actor_id IS NOT NULL AND validated_revision=revision)),
CHECK(status<>'draft' OR (validated_at IS NULL AND validated_by_actor_id IS NULL AND validated_revision IS NULL)),
CHECK(remote_draft_id IS NULL OR (remote_provider IS NOT NULL AND status IN (${VALIDATED}))),
CHECK((dispatch_claim_id IS NULL)=(dispatch_claimed_at IS NULL)),
CHECK(dispatch_claim_id IS NULL OR status IN ('scheduled','sent')),
CHECK((last_error_code IS NULL)=(last_error_at IS NULL)),
FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE CASCADE)`;

// Journal par message : codes, statuts, révision, acteur et détails JSON non-PII (jamais sujet/corps/destinataires).
export const contactMessageEventsTableSql = `CREATE TABLE IF NOT EXISTS contact_message_events(
id TEXT PRIMARY KEY,
message_id TEXT NOT NULL,
event_type TEXT NOT NULL,
from_status TEXT,
to_status TEXT,
revision INTEGER,
actor_type TEXT NOT NULL,
actor_id TEXT,
details_json TEXT NOT NULL DEFAULT '{}',
created_at TEXT NOT NULL,
CHECK(event_type IN (${sqlList(contactMessageEventTypes)})),
CHECK(from_status IS NULL OR from_status IN (${STATUSES})),
CHECK(to_status IS NULL OR to_status IN (${STATUSES})),
CHECK(actor_type IN (${sqlList(messageActorTypes)})),
CHECK(json_valid(details_json) AND json_type(details_json)='object'),
FOREIGN KEY(message_id) REFERENCES contact_messages(id) ON DELETE CASCADE)`;

// File de suppression des brouillons distants devenus obsolètes (édition, annulation, remplacement) : l'appel réseau Toolbox
// ne peut pas être dans la transaction SQLite. `message_id` passe à NULL si le message disparaît : l'id distant reste à supprimer.
export const contactMessageRemoteDraftCleanupsTableSql = `CREATE TABLE IF NOT EXISTS contact_message_remote_draft_cleanups(
id TEXT PRIMARY KEY,
message_id TEXT,
remote_provider TEXT NOT NULL,
remote_draft_id TEXT NOT NULL,
reason TEXT NOT NULL,
attempts INTEGER NOT NULL DEFAULT 0,
last_error_code TEXT,
last_attempt_at TEXT,
completed_at TEXT,
created_at TEXT NOT NULL,
UNIQUE(remote_provider,remote_draft_id),
CHECK(reason IN (${sqlList(remoteDraftCleanupReasons)})),
CHECK(attempts>=0),
FOREIGN KEY(message_id) REFERENCES contact_messages(id) ON DELETE SET NULL)`;

export const contactMessageIndexesSql = [
  // Scan du dispatcher : messages programmés par échéance.
  "CREATE INDEX IF NOT EXISTS ix_contact_messages_due ON contact_messages(scheduled_at) WHERE status='scheduled'",
  // Un brouillon distant n'appartient qu'à un message (pas de double `send_draft` via deux lignes).
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_messages_remote_draft ON contact_messages(remote_provider,remote_draft_id) WHERE remote_draft_id IS NOT NULL',
  // Clé d'idempotence d'envoi unique.
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_messages_dispatch_claim ON contact_messages(dispatch_claim_id) WHERE dispatch_claim_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ix_contact_message_events_message ON contact_message_events(message_id,created_at)',
  'CREATE INDEX IF NOT EXISTS ix_contact_message_remote_draft_cleanups_pending ON contact_message_remote_draft_cleanups(created_at) WHERE completed_at IS NULL',
  // Décision 21 : un message envoyé est consultable mais non modifiable (la suppression en cascade du prospect reste possible).
  "CREATE TRIGGER IF NOT EXISTS trg_contact_messages_sent_immutable BEFORE UPDATE ON contact_messages WHEN OLD.status='sent' BEGIN SELECT RAISE(ABORT,'contact_message_sent_immutable'); END"
];

const TABLES = ['contact_messages', 'contact_message_events', 'contact_message_remote_draft_cleanups'] as const;
const tableSql = [contactMessagesTableSql, contactMessageEventsTableSql, contactMessageRemoteDraftCleanupsTableSql];

/** Compteurs non-PII (journalisés et stockés dans `schema_migrations.report`). */
export type ContactMessagesMigrationReport = { id: string; createdTables: string[]; existingTables: string[]; messageRows: number; eventRows: number };

const tableExists = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columnNames = (db: Db, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
// Noms de colonnes attendus, lus depuis le DDL (une colonne par ligne commençant par un identifiant en minuscules).
const expectedColumns = (sql: string) => sql.split('\n').slice(1).map(line => /^([a-z_]+) [A-Z]/.exec(line)?.[1]).filter((c): c is string => Boolean(c));
const count = (db: Db, table: string) => Number((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);

function ensureIndexes(db: Db) {
  for (const sql of contactMessageIndexesSql) db.exec(sql);
}

/**
 * Crée les tables messages si la migration n'a pas déjà été appliquée ; `null` = déjà appliquée (idempotent, index/trigger
 * garantis). Précondition : `db.exec(schema)` exécuté (table `prospects`, `schema_migrations`). Une table préexistante
 * incomplète fait échouer la migration (rollback) au lieu d'être complétée silencieusement.
 */
export function migrateContactMessages(db: Db): ContactMessagesMigrationReport | null {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(CONTACT_MESSAGES_MIGRATION_ID)) {
    ensureIndexes(db);
    return null;
  }
  return db.transaction(() => {
    const existingTables = TABLES.filter(table => tableExists(db, table));
    tableSql.forEach(sql => db.exec(sql));
    TABLES.forEach((table, i) => {
      const missing = expectedColumns(tableSql[i]).filter(c => !columnNames(db, table).includes(c));
      if (missing.length) throw new Error(`Migration ${CONTACT_MESSAGES_MIGRATION_ID} annulée : colonnes absentes dans ${table} (${missing.join(', ')})`);
    });
    ensureIndexes(db);
    const report: ContactMessagesMigrationReport = {
      id: CONTACT_MESSAGES_MIGRATION_ID,
      createdTables: TABLES.filter(table => !existingTables.includes(table)),
      existingTables: [...existingTables],
      messageRows: count(db, 'contact_messages'),
      eventRows: count(db, 'contact_message_events')
    };
    db.prepare('INSERT INTO schema_migrations(id,report) VALUES(?,?)').run(CONTACT_MESSAGES_MIGRATION_ID, JSON.stringify(report));
    return report;
  })();
}
