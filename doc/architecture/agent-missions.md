# Agent missions — VIPER as a task orchestrator

> **Status: P1 complete for `update_company`, plus tool-mode person updates.** The product page is
> now « Missions » (`doc/architecture/missions.md`): a mission is the persistent rule, a run is one
> execution, and the tasks described here are what an agent claims inside a run. The legacy
> « Analyse » thread remains for the tool-mode proposals (`viper_update_*`), surfaced on the
> Missions page as « Propositions à relire ».
>
> **P1 complete for `update_company`, plus tool-mode person updates.** Working end to end:
> persistence (migration `0018`), lifecycle (`claim`, `heartbeat`, `submit`, `fail`, `release`,
> lease sweep, `open_company_review`, `claim_specific`), the MCP transport and its tokens (migration
> `0019`), the proposal and its review (`accept` applies through `companies.update_company` /
> `prospect_editor.update_prospect`, `reject` requeues), the « Agents » page and the review card.
> The `update_employee`, `find_employees` and `find_prospects` result schemas now exist and can be posted by an agent through the MCP
> `viper_update_prospect` tool (no claim needed); missions still queue only `update_company`, since
> their claim payload for a person is not built yet. **Not there yet:** `find_employees`,
> `surveil_signals`, `find_prospects`, the `signals` migration and the company/`scope` score of
> §4.5. Technical documentation in English, product vocabulary in French.

## 1. The shift

`mcp-server.md` exposes VIPER as a **toolbox an assistant drives on demand**. This document adds a
second, asynchronous mode: VIPER becomes the **orchestrator**, cuts the work into tasks, hands them
to agents that poll, and keeps the results as proposals a person reviews.

The difference matters:

| | Tool mode (`mcp-server.md`) | Mission mode (this document) |
|---|---|---|
| Who decides what to do | the assistant, turn by turn | VIPER, from a thread the human opened |
| Who holds the work | the conversation | `agent_tasks`, in the database |
| Concurrency | one assistant, one call | several agents, asynchronous, leased |
| Result | a direct write or a draft | a **proposal**, never applied without review |
| Failure | the call fails | the lease expires, the task returns to the queue |

Both modes share the same credential, the same audit and the same rule: **an agent proposes, a
person decides.**

## 2. Vocabulary

- **Thread** (`agent_threads`) — « Analyse » : the unit the human sees as one card. One company
  (« 2SN »), or one prospecting brief for `find_prospects`. It groups tasks and nothing else.
- **Task** (`agent_tasks`) — « Mission » : one unit of work an agent can claim, for one type and one
  subject.
- **Result** (`agent_task_results`) — « Résultat » : one agent's submission, immutable, kept with its
  attempt number. This is the **draft** the human reviews.
- **Proposal** — the normalised form of a result: field changes with before/after, or items to
  create, or signals to store. Computed by VIPER on submission, never by the agent.
- **Signal** (`signals`) — a short dated fact with a source and an optional score delta, about a
  **company or one of its people**. It is the renamed `prospect_notes` (§4.4), not a new concept:
  the score service already calls its lines « signaux ».
- **Claim / lease** — the right to work on a task for a limited time, renewed by heartbeat.

## 3. Why the agent never writes directly

The domain already refuses an agent a contact state (`contact_tracking.py:84`), a Contact message
(`contact_messages.py:238`) and a cohort (`contact_sequences.py:391`). Mission results follow the
same line for a different reason: **a wrong `siren` or a made-up e-mail is worse than no data.**
An agent returns *values and evidence*; VIPER validates, normalises, diffs and shows them. Only a
person's click can write them into the base.

Consequences, and they shape everything below:

1. The agent never receives a `version` and never sends a mutation payload.
2. Every field it proposes goes through the same normalisation as the Excel import
   (`services/imports/normalize.py`) and the same matching as the import dedup
   (`services/imports/dedup.py`).
3. Applying an accepted proposal runs the **existing** service (`companies.update_company`,
   `prospect_editor.update`, …) with the **validating person** as actor and `source=agent`, so
   `D7` and the audit stay true.

## 4. Data model

### 4.1 `agent_threads`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | UUIDv7, `UUIDPrimaryKeyMixin` |
| `kind` | enum `agent_thread_kind` | `company_review`, `prospect_search` |
| `company_id` | FK `companies` `RESTRICT`, null | required for `company_review`, null for `prospect_search` |
| `title` | varchar(200) | the company name, or the brief's name, snapshotted |
| `status` | enum | `open`, `paused`, `done`, `cancelled` |
| `brief` | JSONB, default `{}` | `prospect_search` only: sector, geography, size, roles, signal sought |
| `priority` | smallint, default 0 | manual ordering of the cards |
| `note` | text, null | the person's free note |
| `created_by_id` / `created_by_display` | | actor snapshot (`ActorType`, id, display) |
| timestamps | | `TimestampMixin` |

Constraints:
- `num_nonnulls(company_id) = 1` when `kind = 'company_review'`, `company_id IS NULL` when
  `kind = 'prospect_search'`;
- **one open review per company**:
  `UNIQUE (company_id) WHERE kind = 'company_review' AND status IN ('open', 'paused')`. Asking
  « Ajoute cette société à la liste des sociétés à analyser » twice **extends** the existing thread
  instead of creating a second one.

### 4.2 `agent_tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `thread_id` | FK `agent_threads` `CASCADE`, indexed | |
| `type` | enum `agent_task_type` | `update_company`, `update_employee`, `find_employees`, `surveil_signals`, `find_prospects` |
| `company_id` | FK `companies` `CASCADE`, indexed, null | payload + dedup target |
| `prospect_id` | FK `prospects` `CASCADE`, indexed, null | `update_employee` only |
| `status` | enum | `pending`, `claimed`, `submitted`, `accepted`, `failed`, `cancelled` |
| `priority` | smallint | default from the type (§5), editable by the person |
| `attempts` | smallint, default 0 | incremented at each claim |
| `max_attempts` | smallint, default 3 | after it, `failed` |
| `claim_id` | uuid, null | rotates at each claim; proves which agent holds the task |
| `claimed_by_id` / `claimed_by_label` | | agent token id + label, snapshotted |
| `claimed_at` | timestamptz, null | « depuis combien de temps » |
| `lease_expires_at` | timestamptz, null | |
| `last_heartbeat_at` | timestamptz, null | |
| `failure_code` / `failure_message` | | last agent failure (`not_found`, `blocked`, `timeout`…) |
| `created_at` / `updated_at` | | |

Constraints:
- **one open task per (type, subject)** — the creation-level duplicate guard:
  ```sql
  UNIQUE (type, company_id, prospect_id) WHERE status IN ('pending','claimed','submitted')
  ```
  (PostgreSQL treats NULLs as distinct; `find_prospects` is therefore guarded by `thread_id`
  instead — see the partial index in the migration.)
- `CHECK (status <> 'claimed' OR claim_id IS NOT NULL)`, and `lease_expires_at IS NULL` when not
  claimed;
- a subject per type:
  `update_company`/`find_employees`/`surveil_signals` → `company_id NOT NULL AND prospect_id IS NULL`;
  `update_employee` → `prospect_id NOT NULL`; `find_prospects` → both null.

### 4.3 `agent_task_results`

Append-only: one row per submission attempt.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `task_id` | FK `agent_tasks` `CASCADE`, indexed | |
| `attempt` | smallint | the task's `attempts` at submission |
| `submitted_by_id` / `submitted_by_label` | | the agent |
| `submitted_at` | timestamptz | |
| `raw` | JSONB | exactly what the agent sent, after schema validation |
| `proposal` | JSONB | VIPER's normalised reading (§7.2) |
| `digest` | char(64) | SHA-256 of `raw` — the review is bound to what was seen (ADR-0012 spirit) |
| `status` | enum `agent_result_status` | `pending_review`, `accepted`, `rejected`, `superseded` |
| `decided_at` / `decided_by_id` / `decided_by_display` | | the person |
| `decision_note` | text, null | why rejected, or a remark on acceptance |
| `accepted_items` | JSONB, null | the item keys accepted, and the overrides |
| `applied` | JSONB, null | what was actually written (ids created, fields changed) |

The result under review is read from `agent_task_results`, never pointed at by the task: keeping a
`result_id` on both sides would make a circular foreign key for no gain.
`UNIQUE (task_id, attempt)` — one submission per attempt, and `attempt` is the task's `attempts`
at submission time. `UNIQUE (task_id) WHERE status = 'pending_review'` — at most one result waits
for a person at a time; a rejection closes it before the task can be claimed again.

### 4.4 `signals` (phase 2) — `prospect_notes`, renamed and opened to companies

A signal is **what `prospect_notes` already is**: a short dated fact, with an optional score delta.
The table only ever lacked two things — a company as a subject, and a source URL. Renaming it
rather than adding a second table is the point: an agent signal about a person and an agent signal
about a company must be the *same* thing in the base, in the score and in the UI, otherwise the
scoring has two parallel sources of truth.

**Migration**: `prospect_notes` → `signals`; `prospect_id` becomes nullable; `company_id` added;
existing rows are backfilled `origin = 'manual'`, `kind = NULL`. No data is rewritten. The routes
follow: `/prospects/{id}/notes` becomes `/prospects/{id}/signals`, `/companies/{id}/signals` is
added, and the `ProspectNotes` component becomes `ProspectSignals` — the company editor gets the
same block.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `prospect_id` | FK `prospects` `CASCADE`, indexed, **null** | exactly one subject |
| `company_id` | FK `companies` `CASCADE`, indexed, **null** | exactly one subject |
| `fact_text` | text ≤ 1000 | the signal, in one sentence (kept from the note) |
| `kind` | enum `signal_kind`, null | `hiring`, `funding`, `news`, `social_post`, `event`, `product_launch`, `partnership`, `tech_change`, `need_expressed`, `facility_opening`, `facility_expansion`, `construction`, `relocation`, `other` (the four site kinds: migration `0026`) |
| `source_type` | enum `note_source_type`, null | the **channel**: `linkedin`, `email`, `phone`, `meeting`, `web`, `other` (kept) |
| `source_label` | varchar(200), null | « post IGuard », « Welcome to the Jungle » (kept) |
| `source_url` | text, null | **required for an agent signal**, optional for a human one |
| `noted_on` | date, null | when it was observed (kept) |
| `score_delta` | smallint −50…+50, null | the contribution to the score (kept) |
| `valid_until` | date, null | after it the signal no longer counts; null = permanent |
| `origin` | enum `manual` / `agent` | who produced it |
| `task_result_id` | FK `agent_task_results` `SET NULL` | the review it came from |
| timestamps | | |

Constraints:
- `num_nonnulls(prospect_id, company_id) = 1` — the same shape as `quality_alerts`, already used;
- `UNIQUE (company_id, source_url) WHERE source_url IS NOT NULL` and the same on `prospect_id`:
  re-running surveillance never duplicates an article;
- `origin = 'agent'` requires `source_url IS NOT NULL` — an agent must cite, a person may not.

`valid_until` is what makes a signal *news* rather than a permanent truth: a hiring post from 14
months ago must stop inflating a score. Default window by kind at acceptance (hiring 90 d, funding
180 d, press and social post 30 d, site opening / extension / move 180 d, construction 365 d — `agent_payloads.SIGNAL_VALID_DAYS`), editable by the person.

### 4.5 Scoring — extending `ProspectScore`, not replacing it

`prospect_score.py` already writes « Aucun signal enregistré », counts « 3 signaux », and documents
that *"a future automated signal adds another `origin` without changing the contract"*. That is
exactly this. Three additions, all backward compatible:

- `ContributionOrigin = Literal["manual", "agent"]`;
- `ScoreContribution.scope: Literal["person", "company"] = "person"` and `kind: str | None`, so the
  card can badge a line « signal société » and say whether an agent proposed it;
- `source_type` keeps its meaning (`note` for a human line), so `scoreView.contributionSource` and
  its tests keep working.

The computation becomes:

```
total = clamp(base
              + Σ notes/signals on the prospect        (scope "person")
              + Σ signals on its company within the cap (scope "company"))
```

- only signals with `valid_until IS NULL OR valid_until >= today` count;
- company signals are **capped** (`prospect_score_company_cap`, default ±30) so an account-level
  fact cannot drown what the person said; the cap is applied to the company subtotal, not per
  signal, so the breakdown still shows every line;
- the score is still computed on read and never stored (`D-UX2` unchanged).

The company itself gets no separate score in this slice: its signals show as a subtotal on the
thread card and on the company page. If a company-level score is wanted later, it is the same
`build_score` over `scope = "company"`.

### 4.6 Enums to add

`agent_thread_kind`, `agent_thread_status`, `agent_task_type`, `agent_task_status`,
`agent_result_status`, `signal_kind`, `signal_origin` — all `text_enum` with a CHECK (ADR-0002).
`note_source_type` and `AuditSource.AGENT` are reused. New audit entity types `agent_thread`,
`agent_task`, `agent_task_result`; `prospect_note` becomes `signal`.

## 5. Task catalogue

Priority defaults, in the order the human sees them on the card.

### 5.1 `update_company` — « Mettre à jour la société »

- **Target**: `company_id`. **Priority** 50.
- **Missing fields** it may fill: `legal_name`, `siren`, `website_url`, `email_domain`,
  `size_label`, `commercial_segment` and activity categories (by label, resolved by VIPER).
- **Deliberately out of its reach**: the Circoe-internal columns (`project_done_with_circoe`,
  `project_type`, `circoe_references`, `client_approach`) and the establishments. An agent has no
  way to know them, and a plausible guess there is worse than a blank — the schema makes them
  unrepresentable, not merely discouraged.
- **Refused**: anything that is a commercial judgement (`do_not_contact`, segment when ambiguous).
- **Injection**: `companies.update_company`, only the accepted fields.

### 5.2 `update_employee` — « Compléter un employé »

- **Target**: `prospect_id` (and its `company_id`). **Priority** 60 — it is what unblocks a Contact
  sequence.
- **Missing fields**: `civility`, `first_name`/`last_name` corrections, `exact_job_title`,
  `role_id` (by label), `emails`, `phones`, `activity_status`, `employment_verified_at`.
- **Refused**: `contactability_status`, `do_not_contact_*`, the commercial state — a person only.
- **Injection**: `prospect_editor.update` with the current `version` read at accept time.

### 5.3 `find_employees` — « Trouver de nouveaux contacts »

- **Target**: `company_id`. **Priority** 40.
- **Goal**: people at this company who are **not yet in the base**.
- **Injection**: `prospect_editor.create` per accepted item, with the mandatory `provenance`
  (the agent must supply `legal_basis_or_collection_context` + `source_reference`, as
  `ProspectCreate` already requires). Each created prospect gets a `ProspectSource` of type
  `future_agent` — the value already exists in `ProspectSourceType`.
- **Dedup**: the import's `existing_people` / `existing_companies` matching marks each item
  `new` / `already_known` / `duplicate_of_row`; only `new` is checked by default.

### 5.4 `surveil_signals` — « Surveiller les signaux »

- **Target**: `company_id`. **Priority** 30.
- **Goal**: dated, sourced, relevant facts about the company, with a commercial reading. Detailed
  contract in §6 because it is the least obvious type.
- **Injection**: accepted signals become `signals` rows, on the company or on a named person of
  that company; each carries its own `score_delta`.

### 5.5 `find_prospects` — « Trouver de nouveaux prospects »

- **Target**: the thread's `brief`, no company. **Priority** 20.
- **Goal**: companies or people matching the brief, with the evidence that they match.
- **Injection**: creates companies (or links an existing one, like the import) and prospects, after
  a per-item review. This is a supervised mini-import: the result is itemised exactly like an
  import preview, and nothing is written before the review.
- **Sites and trigger** (« nouveaux entrepôts en Normandie »): each `CompanyProposal` may carry
  `establishments[]` (`EstablishmentProposal`: name, kind, SIRET, address, postal code, city,
  country, `opened_on`, `surface_m2`, `source`) and a `trigger` — a `SignalProposal`, the same
  shape as a `surveil_signals` signal, always about the company. Both are optional: a result or a
  stored proposal without them is accepted exactly as before.
  - *Proposal* (`_find_prospects_proposal`): sites are cleaned and deduplicated **by SIRET, then
    by (city, name)** (case and spacing ignored); a SIRET already in `establishments`, or already
    proposed for another company of the result, is refused (`already_known` / `duplicate`); a
    site with neither SIRET nor (name and city) is refused (`unidentified`). The trigger is
    checked like a signal (public http(s) source, not in the future, inside `period_days`). A
    refused site or trigger is listed under `refused` with its path
    (`companies.0.establishments.2`, `companies.0.trigger`); its company stays proposed.
  - *Acceptance* (`agent_review._apply_find_prospects`), in the request's single transaction:
    `companies.create_company` with the sites as `EstablishmentInput` (a SIRET that entered the
    base since the submission is skipped, not recreated; the first site becomes primary), then the
    trigger as a company signal (`origin=agent`, `source_url`, `task_result_id`, `valid_until`
    from the kind). Any failure rolls the whole acceptance back.
  - *Provenance*: the company and its sites are audited as the deciding person's acceptance
    (`company.created`, `establishment.created`); the signal carries its source and result;
    `applied.companies[]` maps each created company to its source, each created site to the
    `source`, `opened_on` and `surface_m2` the agent cited, the skipped sites and the signal id.
    `opened_on` / `surface_m2` / site `source` have no column on `establishments` yet: they live
    on the reviewed result only.
  - *Review card*: under each company row, its sites (name, kind, place, SIRET, opening date,
    surface, source) and its trigger (kind label, date, sentence, score, reason, source).

## 6. `surveil_signals` — the detailed contract

### 6.1 What the agent must look for

Five families, and the agent must say which one each signal belongs to:

1. **Hiring** — a job posting or an announced recruitment, especially for a role adjacent to the
   offer (a sales hire suggests budget; a data hire suggests a data need). Look at the careers page,
   LinkedIn Jobs, job boards, and the company's own posts.
2. **Funding / financial** — a raise, a grant, an annual report, a growth or layoff announcement.
3. **News / press** — an article, an interview, an award, an expansion, a closure, a lawsuit. Only
   dated, attributable sources.
4. **LinkedIn activity** — a post by the company or by one of the targeted people, a change of
   position, a new arrival, a work anniversary worth a pretext. A post is a *signal*, not a fact
   about the base.
5. **Business context** — a new product, a partnership, a technology change (a stack migration, a
   new CRM), an event or a trade show, a site redesign.

For each signal, the agent states **why it matters for the commercial approach**, never just that it
exists. A signal without a consequence is noise and the review card will show it as such.

### 6.2 What it must not do

- No signal without a **dated, public source**. No inference presented as fact.
- No personal data beyond what the base already holds (no private e-mail harvesting).
- No signal older than the window given in the payload (default 90 days), unless it is a
  structural fact (a funding round still open, a product still live).
- No commercial judgement written into the base: the agent proposes a score, it does not set one.
- No duplicate: a signal already stored for the company (same `source_url`) is dropped by VIPER
  before the review, and the agent is told so in the payload (`known_signals`).

### 6.3 Output

The shape the brief asked for — a list of `{signal, score, source}` — with the fields the review
needs on top of it:

```json
{
  "signals": [
    {
      "subject": { "type": "company" },
      "kind": "hiring",
      "signal": "2SN recrute son premier responsable commercial, offre publiée le 12/10.",
      "score": 15,
      "score_reason": "Un premier commercial est recruté : le budget outillage commercial suit généralement de 1 à 2 trimestres.",
      "source": "https://www.welcometothejungle.com/fr/companies/2sn/jobs/...",
      "source_channel": "web",
      "observed_on": "2026-10-12",
      "relevance": 80,
      "sentiment": "positive"
    },
    {
      "subject": { "type": "person", "name": "Marie Dupont" },
      "kind": "need_expressed",
      "signal": "A publié sur LinkedIn un post sur le besoin de souveraineté des données.",
      "score": 20,
      "score_reason": "Le besoin est exprimé publiquement par la personne qui décide, dans notre domaine.",
      "source": "https://www.linkedin.com/posts/marie-dupont_...",
      "source_channel": "linkedin",
      "observed_on": "2026-10-21",
      "relevance": 90,
      "sentiment": "positive"
    }
  ],
  "company_summary": "Trois signaux exploitables : un recrutement commercial, une levée de fonds en septembre, un changement de CRM.",
  "recommended_action": "contact",
  "evidence_gaps": ["Aucune information publique sur le budget outillage."],
  "notes": "Le site ne publie pas d'actualités ; les signaux viennent de LinkedIn et de la presse locale."
}
```

- **`subject`** is what makes a signal about a company *or* about one of its people. The agent
  names the person; it does not know, and must not guess, a `prospect_id`. VIPER resolves the name
  against the company's prospects at proposal time and marks it `unresolved_person` when no one
  matches — the signal stays company-level and the card says so.
- **`score`** is the delta the signal would add, bounded −50…+50 and clamped by VIPER. There is no
  global score object: the sum of the accepted deltas *is* the reading, and a second number would
  only invite the two to disagree. `recommended_action` stays, advisory.
- **`source`** is mandatory for every signal (an agent cites or says nothing).
- `output_schema_version` is bumped when this shape changes; in-flight tasks keep theirs.

### 6.4 Review of a `surveil_signals` result

The card is not a diff — it is a **signal board**:

- one row per signal: kind badge, subject (`2SN` or `Marie Dupont`), date, the sentence, the
  source link, the delta in colour (`+15`), and « pourquoi ça compte »;
- each row has a checkbox (accepted by default when `relevance ≥ 50` and the date is inside the
  window) and an editable score, because the person's judgement beats the agent's;
- an unresolved person is shown as « personne non reconnue » with a picker to attach the signal to
  the right prospect, or leave it on the company;
- a signal already known (same `source_url`) is greyed « déjà connue » and unselectable;
- the company summary and the advisory action are shown, never applied.

Accepting inserts the selected signals in `signals`, computes `valid_until` from the kind (hiring
90 d, funding 180 d, press and social post 30 d, structural null) and leaves it editable. It writes
nothing to the company row. The prospect scores that include these signals change on the next
read — the score is never stored.

## 7. Lifecycle

### 7.1 State machine

```
                 claim (row lock)                submit (schema OK)
   pending ──────────────────────> claimed ──────────────────────> submitted
      ▲                               │                                │
      │                               │ fail / abandon                 │ accept (person)
      │                               ▼                                ▼
      │                            pending ──attempts > max──> failed  accepted
      │                               ▲
      └──────── reject (person) ──────┘
   any state ──── cancel (person) ────> cancelled
```

- **Lease expiry** is not a state: a sweeper (lazy, at the start of any claim) puts an expired
  `claimed` task back to `pending`. `attempts` was already incremented at claim, so a task that
  keeps dying on one agent ends up `failed` instead of looping forever.
- **`submitted` is the only state a person acts on.** No timeout: a submitted result waits as long
  as the review takes.
- **Rejection** puts the task back to `pending` (another attempt) and records the reason on the
  result; after `max_attempts` it becomes `failed` with `failure_code = 'rejected'`. The person can
  always « Relancer » a task explicitly, which resets `attempts`.
- **`accepted` and `failed` are terminal** for the task; the thread can be re-opened by adding a
  task, never by silently reviving a decided one.

### 7.2 Claim algorithm

One short transaction, in this order:

```sql
-- 1. sweep the expired leases (no lock held afterwards)
UPDATE agent_tasks SET status = 'pending', claim_id = NULL, claimed_by_id = NULL,
       claimed_by_label = NULL, claimed_at = NULL, lease_expires_at = NULL,
       last_heartbeat_at = NULL
 WHERE status = 'claimed' AND lease_expires_at < now();

-- 2. pick one and claim it, under the row lock
SELECT id FROM agent_tasks
 WHERE status = 'pending'
   AND type = ANY(:allowed_types)              -- the token's scopes
   AND (:thread_id IS NULL OR thread_id = :thread_id)
 ORDER BY priority DESC, created_at ASC
 FOR UPDATE SKIP LOCKED
 LIMIT 1;
```

Then the row is updated with a fresh `claim_id`, the agent's identity, `lease_expires_at =
now() + lease`, `attempts = attempts + 1`, `status = 'claimed'`. `SKIP LOCKED` is what makes
concurrent agents safe: two claimers never see the same free row, and neither waits for the other.
The dispatcher already relies on the same primitive (`contact_dispatch.py:355`).

Then the payload is built **at claim time**, from live data — never stored at task creation, so an
agent never works on a stale snapshot.

**Fairness.** A token declares `max_concurrent` (default 3). A claim is refused
(`too_many_claims`, 429) above it, so one agent cannot drain a thread. Optionally an agent asks for
one type at a time; the server does not shuffle.

### 7.3 Payload returned to the agent

```json
{
  "task_id": "0192f3…",
  "task": "update_employee",
  "task_label": "Compléter un employé",
  "instruction": "Complete this person's missing information. Quote a public source for every value.",
  "thread": { "id": "0192f4…", "title": "2SN" },
  "subject": { "prospect_id": "0192f5…", "company_id": "0192f6…" },
  "user_data": {
    "civility": null,
    "first_name": "Marie",
    "last_name": "Dupont",
    "exact_job_title": null,
    "role": null,
    "emails": [],
    "phones": [{ "number": "+33…", "type": "mobile", "is_primary": true }],
    "activity_status": "unknown",
    "employment_verified_at": null,
    "do_not_contact": false
  },
  "company_data": {
    "id": "0192f6…",
    "display_name": "2SN",
    "legal_name": null,
    "siren": null,
    "website_url": "https://2sn.fr",
    "email_domain": "2sn.fr",
    "size_label": null,
    "address": { "city": "Lyon", "country": "FR" }
  },
  "missing_fields": ["exact_job_title", "emails"],
  "sources": [
    { "kind": "website", "url": "https://2sn.fr" },
    { "kind": "search", "url": "https://www.linkedin.com/company/2sn" }
  ],
  "search_hints": ["\"Marie Dupont\" 2SN", "site:linkedin.com \"Marie Dupont\" 2SN"],
  "known_values": { "emails": [], "phones": ["+33…"] },
  "known_signals": [],
  "output_schema": { "…": "JSON Schema, generated from the Pydantic model of the type" },
  "output_schema_version": 2,
  "constraints": {
    "no_guessing": true,
    "quote_evidence": true,
    "max_items": 20,
    "language": "fr"
  },
  "lease": { "expires_at": "2026-10-29T15:45:00Z", "heartbeat_every_seconds": 300 },
  "context": { "today": "2026-10-29", "locale": "fr-FR" }
}
```

Rules:
- `user_data` carries only the fields needed to judge what is missing — no `version`, no internal
  ids beyond the subject, no audit.
- `sources` are URLs VIPER already knows (never crawled content); `search_hints` are suggested
  queries. VIPER does not browse; the agent does.
- The schema is **generated from Pydantic** (`model_json_schema()`), so the validator and the
  published schema cannot drift. `output_schema_version` (one number for every type,
  `agent_payloads.SCHEMA_VERSION`) is sent with each payload; it is not stored on the task, so a
  shape change must stay additive (new fields optional) for an in-flight agent's result to remain
  valid. Version 2 added the optional `establishments` and `trigger` of a `find_prospects` company.

## 8. MCP surface (agent side)

| Tool | Purpose |
|---|---|
| `viper_claim_task` | Claim the next task matching the token's scopes; returns the payload above. *This is the `get_task()` of the brief, named after what it does.* |
| `viper_heartbeat_task` | Renew the lease; returns the remaining seconds (`task_id`, `claim_id`) |
| `viper_submit_task_result` | Submit a result; validated against the type's schema. Invalid → `422` with field errors, the lease stays held so the agent can fix and retry |
| `viper_fail_task` | Give the task back with a code (`not_found`, `blocked`, `forbidden`, `timeout`) and a message |
| `viper_release_task` | Give the task back without failure (the agent stops, no penalty) |
| `viper_task_queue` | Count of available tasks by type for this token — cheap polling, no claim |

`viper_submit_task_result` is the only write. It never applies anything: it stores `raw`, validates
it, and returns `{ "result_id", "status": "pending_review", "proposal_summary": {...} }`.

**Exactly-once submission.** The `claim_id` must match the current claim. A retried submission
(same `claim_id`, same `digest`) returns the existing result instead of creating a second one. A
submission from a lost claim is refused (`claim_lost`, 409) without touching the task.

## 9. REST surface (human side)

| Route | Purpose |
|---|---|
| `GET /api/agents/threads` | The cards: filter by status/kind/search, with `tasks_total`, `tasks_done`, `agents_active`, `last_activity_at` |
| `POST /api/agents/threads` | « Ajouter une société à analyser »: `company_id` or a new company; creates the thread **and** its tasks (§10) |
| `GET /api/agents/threads/{id}` | Thread detail: tasks grouped by type, agents, counters, accepted signals |
| `PATCH /api/agents/threads/{id}` | `status` (pause/resume/close), `priority`, `note` |
| `POST /api/agents/threads/{id}/tasks` | Add a task by hand (`type` + target) |
| `GET /api/agents/tasks` | The global queue, filterable by type/status/thread/agent — « organiser la liste des tâches » |
| `PATCH /api/agents/tasks/{id}` | `priority`, `cancel`, `retry` (reset attempts) |
| `GET /api/agents/results/{id}` | The proposal + diff + evidence + digest |
| `POST /api/agents/results/{id}/accept` | `accepted_items`, `overrides`, optional `note` |
| `POST /api/agents/results/{id}/reject` | `reason` (required) |
| `GET /api/agents/workers` | Tokens at work: label, scopes, tasks in flight, last seen — « combien d'agents en cours » |

**Shipped in P1:** the thread routes (list, create, detail, status) and the three result routes
(get, accept, reject). The queue-level ones (`/tasks`, `/workers`) belong to P3.

Audit events: `agent_thread.created` / `.status_changed`, `agent_task.created` / `.claimed` /
`.submitted` / `.failed` / `.expired` / `.cancelled`, `agent_task_result.accepted` /
`.rejected`. `agent_task.claimed` is written by the agent actor; `.accepted` by the person, with
`source=agent` and the agent's identity in the payload.

## 10. Opening a thread

« Ajoute cette société dans la liste des sociétés à analyser complètement » →
`POST /api/agents/threads { company_id }`:

1. If an open/paused thread already exists for that company: return it (`created: false`) and only
   add the missing tasks. This is the first of the three duplicate guards.
2. Otherwise create the thread (`company_review`, `title` = company `display_name`).
3. Create the tasks the thread needs, each one skipped when an identical open task already exists:
   - `update_company` — when the company misses at least one fillable field;
   - `surveil_signals` — always (a review is also a surveillance pass);
   - `find_employees` — when the company has fewer than the configured minimum of open contacts
     (default: 1);
   - `update_employee` — **one per prospect of the company** with at least one missing field
     (no primary e-mail, no phone, no role, no `employment_verified_at`). This is what makes a
     20-person company produce 20 parallel tasks, and why the page needs counts and filters.

**P1 ships steps 1-2 and the first, third and fourth bullets**: `update_company` and
`update_employee` are the two types whose result schema exists. `surveil_signals` and
`find_employees` join the same function in P2, when their schemas do — a task whose schema does
not exist would be a task no agent can complete.

The task creation is idempotent: re-running it on the same company adds nothing. A concurrent
double click is caught by the partial unique indexes of §4.2, which act as the backstop.

## 11. Review and injection

### 11.1 Building the proposal

On submission, VIPER (never the agent):

1. validates `raw` against the Pydantic model of the type;
2. normalises every value with the import's rules (e-mail lowercase and syntax, phone E.164, SIREN
   checksum, URL with scheme, trimmed names);
3. compares with the current row → `changes: [{field, before, after}]` (the shape of
   `audit_changes.diff`, which the review card already speaks);
4. matches entities for the `find_*` types (`new`, `already_known`, `duplicate`);
5. computes `stale: true` when the row changed after the task was claimed (the `version`/`updated_at`
   captured in the payload versus the row now) — the card then shows a warning and the accept
   refuses with `stale` until the person re-reads.

### 11.2 Accepting

- **Item-level.** `accepted_items` is a list of item keys (one field group, one discovered person,
  one signal). The person can accept 2 of 3 discovered people. Unchecked items are simply not
  written; they stay visible on the result as « refusé ».
- **Overrides.** The person may correct a value before accepting; the card records it
  (`overrides`), and the audit shows both the agent's value and the person's.
- **One transaction per acceptance**, like `import_commit`: all accepted items are written or none.
- **Actor.** `ActorContext(type=HUMAN, id=<the person>)`, `AuditContext(source=AGENT)`, and the
  result id in the history, so the base can say « proposé par l'agent X, accepté par Lucie le … ».
- **Provenance.** A created prospect gets a `ProspectSource` with `source_type = future_agent`,
  `source_reference` = the agent's URL, and the `legal_basis_or_collection_context` the agent
  supplied — refused if absent.
- **Signals** are inserted as `signals` rows in the same transaction, one per accepted item, with
  their subject resolved (`company_id`, or `prospect_id` when the person was recognised or picked),
  their `source_url`, their `score_delta` and the `valid_until` computed from the kind. A signal
  never edits the company or the person: it only adds a line the score will read.

### 11.3 The review card

```
┌ 2SN › Compléter un employé ──────────────── Marie Dupont ─────────────┐
│ Agent « claude-01 » · soumis il y a 12 min · tentative 1/3            │
│                                                                       │
│  Champ              Actuel            Proposé            Source        │
│  Fonction           —                 Directrice RH      [linkedin]    │
│  Rôle               —                 RH                [linkedin]    │
│  E-mail pro         —                 m.dupont@2sn.fr   [site]        │
│                                                                       │
│  ⚠ 1 valeur écartée : téléphone au format invalide                    │
│                                                                       │
│  [ Tout accepter ]  [ Accepter la sélection ]  [ Rejeter ]            │
└───────────────────────────────────────────────────────────────────────┘
```

Colour code, reused from the design system: green = value added, amber = value changed, red =
refused / invalid, grey = unchanged. The raw JSON is reachable behind « Voir le JSON reçu », as the
brief asks.

## 12. The « Agents » page

- **Route** `/agents`, a `PAGES` entry in `frontend/src/routes.tsx`, a `navigation.ts` section
  between « Contact » and « Agenda ».
- **List view** — one card per thread: company name, a status pill (`ouverte`, `en pause`,
  `terminée`), a progress bar `X/N`, `agents_active` with the agents' labels, the last activity,
  the oldest pending task's age. Clicking opens the thread.
- **Header action** — « Ajouter une société à analyser »: a company search (reusing
  `GlobalSearch`'s company results) or a new company form, then `POST /agents/threads`.
- **Filters** — by status, by kind, « seulement celles avec des résultats à relire » (the default
  landing view should surface work waiting for a person, not empty threads).
- **Thread detail** — tasks grouped by type, each row: type icon, subject (person or company),
  status pill, agent label, elapsed time, attempts, « Relancer » / « Annuler ». A task with a
  `submitted` result opens the review card (§11.3). Accepted signals are listed under the thread.
- **Empty state** — « Aucune analyse en cours. Ajoutez une société pour commencer. »
- **Prospect/company side** — the existing detail views gain an `agent_activity` block (« Analyse
  en cours par *claude-01* depuis 8 min »), which is the visible half of requirement 1: the person
  sees that the record is being worked on, and by whom.

## 13. Security, limits, and what an agent can never do

- **Scopes.** A token carries the task types it may claim and `max_concurrent`. An agent scoped to
  `update_employee` never sees a company task.
- **Isolation.** A payload is returned only to the claimer; no tool lists other agents' results.
- **No auto-apply, ever.** `submit` cannot write. There is no `viper_apply_result` tool.
- **Validation is server-side and strict**: schema, lengths, URL scheme (`http`/`https` only), no
  HTML, e-mail syntax, SIREN checksum, phone normalisation. A rejected payload names the fields.
- **Prompt injection.** Everything returned by an agent is *data*. The review card renders text,
  never HTML; a `source_url` is displayed as text and opened only on click; a summary containing
  instructions is just a summary.
- **Rate limits.** Claims per minute per token, `max_concurrent`, and a per-thread cap so one
  company cannot absorb every agent.
- **Retention.** `raw` and `proposal` hold personal data; the same open question as the audit log
  (`audit-and-provenance.md`) applies. Default: keep results until the thread is closed, then keep
  the accepted ones and purge the rejected `raw` after N days.
- **Failure to deliver is visible.** A thread with tasks `failed` or a lease that keeps expiring
  shows it on the card — the opposite of the silent scheduled message of 2026-10-02.

## 14. Phasing

**P1 — the spine.** Migration (3 tables, 5 enums), models, `claim`/`heartbeat`/`submit`/`fail`/
`release` MCP tools, payload builders for `update_company` and `update_employee`, proposal + diff,
accept (via the existing services), `GET/POST /agents/threads`, the Agents list and detail pages,
the review card for field changes. **No signals, no discovery yet.** This is already useful: a
company gets analysed, and the person reviews field by field.

**P1 shipped** for one type: the loop « a person opens an analysis → an agent claims → submits →
the person accepts » runs, with `viper_claim_task`, `viper_heartbeat_task`,
`viper_submit_task_result`, `viper_fail_task`, `viper_release_task`, `viper_task_queue`.

**P2 — discovery and signals.** `find_employees` (+ dedup reuse), `find_prospects`, the
`prospect_notes` → `signals` migration and the score extension of §4.5, `surveil_signals` and the
signal board. The migration is the first step of this phase: it touches `prospect_score`,
`services/prospect_notes.py`, the `/prospects/{id}/notes` routes and the `ProspectNotes` component,
all of which already have tests.

**P3 — orchestration comfort.** Global queue with manual ordering, `workers` monitoring, per-thread
caps, retention job, `agent_activity` on the prospect and company pages, retry policies.

## 15. Open questions

1. **Who may accept a result?** Any signed-in person, or only the one who opened the thread? The
   pilot has a single user; the model should not assume it stays that way.
2. **Can an agent hold several tasks of the same thread?** Default: yes, up to `max_concurrent`.
   The alternative (one agent per thread) spreads the risk but serialises a 20-employee company.
3. **Lease length and heartbeat.** Proposed: 15 min lease, heartbeat every 5 min, no automatic
   re-queue before expiry.
4. **`find_prospects` output.** Companies first (then the human picks which to analyse), or people
   directly? The first matches the thread model better; the second matches the current base.
5. **Company-level score.** §4.5 keeps the score per prospect and shows a company subtotal. If the
   product wants a company *score* (to rank accounts in the Agents page), it is `build_score` over
   `scope = "company"` — cheap, but it is a new concept on the screen.

## 16. Trying it

```bash
cd backend
.venv/bin/python -m app.cli create-agent-token --label "Mon agent" --scopes "*"
# prints the token once — only its hash is stored
```

**Paramètres > MCP** lists every exposed tool with its description and its parameters (served by
`GET /api/settings/mcp`, generated from `app/api/mcp.py` — nothing to keep in sync by hand).

Then, with the API on `http://127.0.0.1:8042` and `TOKEN` holding the value:

```bash
curl -s localhost:8042/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"viper_claim_task","arguments":{}}}'
```

The answer is the mission payload (`task_id`, `claim_id`, `company_data`, `missing_fields`,
`output_schema`). Submit it back:

```bash
curl -s localhost:8042/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"viper_submit_task_result","arguments":{
         "task_id":"…","claim_id":"…",
         "result":{"legal_name":"2SN SAS","confidence":80,
                   "evidence":[{"field":"legal_name","source":"https://2sn.fr/mentions"}]}}}}'
```

The task turns « À relire » on `/agents`; click it, check the fields, accept — the company is
written by the ordinary service, attributed to you. Scopes are the task types the token may claim
(`--scopes update_company,update_employee`), `--max-concurrent` caps how many it holds at once.

**Tool mode, without claiming a mission.** The same token reads the base and posts a proposal:

```bash
# 1. find the record
curl -s localhost:8042/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"viper_list_companies","arguments":{"search":"2SN"}}}'
curl -s localhost:8042/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"viper_get_prospect","arguments":{"prospect_id":"…"}}}'

# 2. post the result JSON — nothing is applied
curl -s localhost:8042/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"viper_update_company","arguments":{
         "company_id":"…",
         "result":{"legal_name":"2SN SAS","confidence":80}}}}'
```

`viper_update_company` / `viper_update_prospect` store a `pending_review` result (same card, same
accept path as a mission submission). They never write: a person's accept does. The token scope
still applies (`update_company` / `update_employee`).
