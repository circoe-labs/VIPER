# 05 — Critical Review of the first handoff

## What was already strong

The first handoff correctly captured the central V1 reset: database-first, manual prospecting, Excel as an adapter rather than schema, Prospect/Company split, email/phone alias tables, role taxonomy + exact title, activity status + verification date, establishments, SIREN/SIRET, lightweight contact tracking, Home/Prospection/Database/Settings/Exploitation, DBeaver-style explorer, Neon Command, and the selected logo family.

## Material gaps fixed in this revision

### 1. Audit sequencing was internally inconsistent
Tasks for import/editor already required audit events, but the audit implementation task came near the end. This revision introduces audit/provenance core before any mutation-heavy features, leaving only the visible history UI for later.

### 2. Secure single-user authentication was omitted
The source-of-truth requires one securely authenticated commercial account. A dedicated early task now establishes authenticated actor context without overbuilding RBAC.

### 3. Contact provenance/legal context was under-modeled
The source requires source, date added and legal basis/collection context for contacts. `prospect_sources` and provenance rules now exist explicitly.

### 4. Do-not-contact was too weak
Representing `do_not_contact` only as a contact-tracking status risks accidental reactivation on future cycles/imports. It is now a durable contactability restriction distinct from `Non intéressé`.

### 5. Company email domain was missing
The functional source expects company/domain information and dedup can use it. `email_domain` is now an explicit company field.

### 6. Reply/no-reply dashboard semantics were incomplete
The later UI grill explicitly asked for sent/contacted, responses and no-response views. Contact tracking now supports a response event/timestamp/status so Home can calculate these manually without a mail integration.

### 7. Company data had no real maintenance UI
The user explicitly wanted to manually feed the company table. The first handoff only offered a company selector/link and raw Database editing. A dedicated lightweight Company editor is now included.

### 8. Verification feedback needed clearer semantics
The user wants visual identification of unverified/stale fields while also explicitly rejecting a single mixed verification/status field. The revised contract uses employment verification at Prospect level and independent Email/Phone verification, with imported dynamic values visibly unverified.

### 9. Excel legacy profiling was incomplete
The review inspected the real workbook and added actual structural anomalies: `retraité` in the week field, civility variants, an invalid category value, empty current stage/address columns, duplicate emails and repeated companies. Synthetic tests now cover these without publishing PII.

### 10. Unknown legacy data preservation was too tentative
`when feasible` was too weak. Unknown/opaque row values are now deliberately stored as legacy metadata so useful information is not silently lost.

### 11. Database Explorer was too large for one task
The original task bundled grid engine, advanced table UX, writes, SQL and security. It is split into read/metadata/grid, staged writes, and read-only SQL tasks.

### 12. Excel import was too large for one task
Parsing/mapping/dedup logic and review/commit UI are now separate tasks, improving testability and handoff quality.

### 13. The moodboard could mislead implementation
Neon Command contains cyber-security content and a different snake logo. The revised design spec says explicitly: copy the visual language only; use the selected geometric Viper/V logo assets.

### 14. Public-repo data leakage risk was understated
The target repo is public. The real Excel workbook is now explicitly private/local-only; committed tests must use synthetic fixtures.

### 15. Campaign targeting must not become a DB constraint
The source requirements target Normandie + transport/logistics, but the current historical workbook is broader. The database/import layer must not reject non-target records; targeting belongs to later business/agent logic.

## Still intentionally unresolved
Exact stack, hosting/retention/backup policy, exact export column ordering, legacy Mode de contact semantics, week-year conversion, multiple contact cycles, and future mail/Calendly/agent integration mechanics.
