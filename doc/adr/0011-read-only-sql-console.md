# ADR-0011 — Read-only SQL console: a dedicated database role is the boundary

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 13 (read-only SQL console), for orchestrator review
- Related: [ADR-0005](0005-database-explorer-grid.md) (exposure policy), [ADR-0008](0008-explorer-staged-writes.md)
  (write path), [ADR-0006](0006-audit-integration.md) (audit), `doc/features/database-explorer.md` (*SQL console*),
  decision log I-67 … I-69
- Numbers 0009 and 0010 are left to parallel branches.

## Context

The user wants a discreet SQL surface for power reads. It must never become a write backdoor, must not reveal what
the explorer hides (login accounts and session token hashes, `alembic_version`), and must stay resource-bounded. A
SQL parser cannot be the guarantee: PostgreSQL's grammar is large (writable CTEs, `SELECT … INTO`, `FOR UPDATE`,
functions with side effects, `COPY … PROGRAM`, `DO` blocks, multi-statement strings), and a parser bug would be a
data breach. The database already knows how to refuse: privileges, read-only transactions, timeouts.

## Decision

1. **A dedicated login role, `viper_sql_reader`** (setting `VIPER_SQL_READER_ROLE`, password
   `VIPER_SQL_READER_PASSWORD`; the local default is a development value like `viper`/`viper`), with only `LOGIN`
   (no superuser, createdb, createrole, replication, bypassrls, `NOINHERIT`, no membership of any role — checked, a
   role with more is refused), `CONNECTION LIMIT 10`, and role defaults `default_transaction_read_only = on`,
   `statement_timeout = 10s`, `idle_in_transaction_session_timeout = 15s`, `lock_timeout = 2s`,
   `search_path = public`.
2. **Grants derived from the exposure policy**: `USAGE` on schema `public`, `CONNECT` on the database, and
   column-level `SELECT` on the visible, unmasked columns of exactly the exposed tables — nothing else (no table-level
   privilege, no sequence, no function beyond PostgreSQL's defaults; administrative functions such as
   `pg_read_file`, `lo_import` or `pg_terminate_backend` on others' sessions stay refused by PostgreSQL). Provisioning
   revokes everything first, so a table leaving the policy loses its grant; a test compares the role's privileges with
   the policy.
3. **Provisioning is explicit and idempotent**: `python -m app.cli provision-sql-reader` creates or aligns the role
   (needs `CREATEROLE`; otherwise it prints the statements an administrator must run, password elided) and resets the
   grants (needs only ownership of the tables, i.e. the application role). Run after every migration. The test
   suite and the E2E setup run it; no migration does, because a migration would need a password and CREATEROLE.
4. **Execution** on a separate engine logged in as the reader, with `NullPool` (one connection per query, closed
   afterwards: no `SET`, advisory lock or other session state survives a query), in a transaction set `READ ONLY`
   with `SET LOCAL statement_timeout` (5 s by default, `VIPER_SQL_STATEMENT_TIMEOUT_MS`), always rolled back. The
   statement is sent as a **prepared statement** (the extended protocol refuses several commands) through a
   **server-side cursor** (`DECLARE … CURSOR FOR <query>`, which also refuses data-modifying CTEs) and at most
   `max_rows + 1` rows are fetched (1 000 by default, `VIPER_SQL_MAX_ROWS`) — a huge result is never transferred.
   `EXPLAIN` (not declarable, small output) is executed directly. Cells longer than 500 characters are cut and
   flagged.
5. **Early checks for readable messages only**: empty text, several statements (a scanner aware of quotes, dollar
   quotes and comments), a first keyword other than `SELECT`, `WITH`, `VALUES`, `TABLE`, `EXPLAIN`. Nothing relies
   on them; the security tests also run dangerous statements on raw reader connections.
6. **Endpoint** `POST /api/explorer/sql` (session + CSRF, like every unsafe method), French errors mapped from
   SQLSTATE (syntax with position, « Table non accessible » for hidden tables, read-only refusal, timeout,
   unknown object), 503 when the reader cannot connect. **Every attempt is audited** as `explorer.sql_executed`
   (source `database_explorer`) with the SHA-256 and length of the query text, the outcome, the row count, the
   truncation flag and the duration — **not the text** (it may contain personal literals, and the audit log is
   append-only with an undecided retention).

## Consequences

- Writes and hidden data are impossible through this path even if the checks, the cursor wrapping or the endpoint
  had a bug: the role simply has no privilege. The regression suite proves it against the real database.
- The console sees only committed data and exactly the exposed columns; masking a column in the policy removes it
  from the console at the next provisioning (queries naming it fail with « Table non accessible »).
- Catalog metadata stays readable (table and column names of `pg_catalog` / `information_schema`, including of hidden
  tables) — names, never rows. Accepted: the schema is public in the repository anyway.
- Operations: one more secret (`VIPER_SQL_READER_PASSWORD`) and one more command after migrations. Forgetting it
  shows as « Console SQL indisponible » (503) or « Table non accessible » for new columns, never as a leak.
- One connection per query costs a few milliseconds; acceptable for a discreet console. `CONNECTION LIMIT 10`
  bounds concurrent consoles.
- Queries are not stored anywhere; the hash lets an investigator confirm that a given text was run.

## Alternatives considered

- **Parser allowlist (sqlglot, pglast) as the boundary** — a new dependency and a guarantee only as good as the
  parser's coverage of PostgreSQL; kept only as an early, cosmetic check.
- **Read-only transaction with the application role** — `SET TRANSACTION READ ONLY` can be undone in the same
  session and the application role can read `users`/`user_sessions`; privileges are a stronger boundary.
- **Views or a separate schema** — duplicates the policy in SQL and needs maintenance; column grants follow the
  policy directly.
- **Row-level security** — not needed: the policy is per table/column, not per row.
- **A migration creating the role** — needs CREATEROLE and a password inside migrations (which never read app
  settings); rejected in favour of the explicit command.
- **Pooled reader connections with `DISCARD ALL`** — works, but a forgotten reset would leak session state between
  queries; `NullPool` makes isolation structural.
- **Storing the SQL text in the audit log** — most useful for investigation, but copies personal data into an
  append-only log (see I-27); the hash keeps verifiability without the content.
