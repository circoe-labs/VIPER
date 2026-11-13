# Missions — the persistent rule, its runs, its results

> **Status: phases 1–3 shipped, phase 2 partial.** The model (`missions`, `mission_targets`, `mission_runs`, migration
> `0020`), the API (`/api/missions`), the « Missions » page, the « + Nouvelle mission » modal with
> linked data and recurrence, the detail page (runs, tasks, review) and the run generation for
> **enrichment / verification**, **prospection** (`find_employees` with linked companies,
> `find_prospects` without), **signals** (`surveil_signals`, stored as dated sourced rows) and the
> recurrence scheduler are in place (phases 1–3):
> `MissionScheduler` (one daemon thread, one transaction per pass) starts due runs from
> `next_run_at`, closes an exhausted recurrence and pauses a type it cannot execute. Discovery and
> A signals mission needs at least one linked company and stores accepted signals in
> `prospect_notes` (`origin=agent`, `source_url`, `kind`, `observed_on`, `valid_until`). Contract for the
> agent side: [`mcp-server.md`](mcp-server.md) and [`agent-missions.md`](agent-missions.md).

## 1. The shift from « Agents » to « Missions »

The page used to be organised around « Analyses » (`agent_threads`): one company, its tasks, the
agent that happened to claim them. The product's object is the **mission** — what a person decides
to have done — and the agent is only a property of it. The page is therefore `/missions`, the CTA is
« Nouvelle mission », and a **run** is what the card shows as « dernière exécution · 7 résultats ».

```
Mission (persistent rule)
  └── Run (one occurrence: manual or scheduled)
        └── Task (claimed by an agent over MCP, one subject)
              └── Result (proposal, pending a person's review)
```

`agent_threads` remains only for the legacy company review and the tool-mode `viper_update_*`
proposals; a mission task carries `run_id` and no `thread_id`.

## 2. The mission record

| Field | Notes |
|---|---|
| `name` | free, suggested from the first line of the consigne |
| `type` | the **technical execution discriminator**: `prospection`, `signals`, `enrichment`, `verification`, `other`. Routing (`check_runnable`, task generation, payload) reads this column only; it always equals the category's `mission_type` (§7c) |
| `category_id` | the product category (name, icon, colour, general prompt, default skills), `RESTRICT` on delete; `NULL` only for a row written outside the service |
| `overridden_fields` | JSON list of the category-derived fields a person set explicitly (`prompt`, `skills`); a field not listed follows its category (§7c) |
| `prompt` | the consigne, verbatim; never copied into a task. Inherited from the category's general prompt unless `prompt` is in `overridden_fields` |
| `agent_id` / `agent_label` | `NULL` = « Automatique »: any agent with the scope may claim; the label is snapshotted |
| `is_recurring`, `interval_count`, `interval_unit` | ponctuelle, or every N hours/days/weeks/months |
| `starts_at`, `end_kind`, `ends_at`, `max_runs` | now or a date; never / at a date / after N runs |
| `result_kind`, `result_limit` | what is expected, and the **cap** per run (never the goal: see `objective`) |
| `allow_multiple` | `false` (default): one item per submission; `true`: the list envelope (`agent-missions.md` §7.4). Missions that predate migration 0049 are `true` |
| `objective` | machine-evaluable goal, §4b. `NULL` = `tasks_accepted` |
| `geography`, `period_days`, `exclusions` | advanced filters, passed to the agent in the payload |
| `next_run_at`, `last_run_at` | derived scheduling state |

**Two modes, one type vocabulary.** A mission with no target is a *discovery* mission; a mission
with linked records is a *base-work* mission. That is why there is no `discovery` type next to
`enrichment`: the linked data says which mode it is, and the modal stays at six visible fields.

## 3. Linked data

`mission_targets` stores `(mission_id, company_id | prospect_id)`, exactly one subject per row,
with a unique pair per mission. The consigne is never a copy of the record: the agent re-reads the
live company/prospect when it claims the task, so a mission written on Monday works on Friday's row.

Targets are **not** context: a record linked as supporting context (read-only, `mission_context_refs`,
§7d) is never a task subject and never a write path.

The modal's « + Ajouter des données » behaves like an attachment: a search by type (Sociétés /
Prospects), multiple checkboxes, then chips (`Transports X × Jean Dupont × +11`). The picker reuses
`companies.list_companies` and `GET /api/missions/targets?kind=prospect&q=`.

## 4. Runs and tasks

**An active mission is open to the agents; there is no « Lancer maintenant ».** VIPER never starts
an agent: agents connect and claim the tasks of active missions. A run is created when the mission
becomes active (at creation, or « Activer » before its first run) unless its start is in the
future, then by the scheduler at its start date and at each recurrence (`run_due`, one-offs
included). « Désactiver » (`paused`, shown « Inactive ») hides its tasks from the agents. A run
creates a `mission_runs` row and one task per target:

- enrichment / verification, company target → `update_company` (public fields, SIREN/website/
  domain/segment/categories);
- enrichment / verification, prospect target → `update_employee` (identity, role, title, e-mails,
  phones, activity);
- **prospection** with company targets → `find_employees` (people to discover, deduped against the
  base, created as `future_agent` after review);
- **prospection** without targets, expected result « Sociétés » → one `find_prospects` task: new
  companies matching the brief, deduped by name/SIREN/domain, created after review — with the sites
  the brief is about (deduped by SIRET, then city + name) and the dated trigger that brought each
  one in (a company signal such as `facility_opening`), all three in the acceptance's single
  transaction (`agent-missions.md` §5.5).

Prospect-only or company-only missions are therefore both possible. A run's status is derived from
its tasks (`refresh_run`): `running` while a task is pending/claimed/submitted, `done` when all are
decided; `tasks_total`, `results_count` and `finished_at` follow.

A mission may name its agent: every generated task carries `assigned_agent_id`, and
`agent_missions.claim` refuses it to any other token. « Automatique » leaves it `NULL`.

**Scheduling.** A recurring mission whose start is now (or in the past) gets `next_run_at = now`, so
the worker starts it on its next pass; a future start waits. After each run, `next_run_at` advances
by the interval, and an exhausted recurrence (`ends_at` or `max_runs`) closes the mission.

**A run keeps its rule.** When a run starts, `mission_runs.config` (migration 0027) stores the
payload's `mission` block (§5: name, type, prompt, result kind and limit, geography, period,
exclusions; `agent_payloads.mission_rule`). Its tasks are claimed with that block, and their results
are checked against its `result_limit` / `period_days`, so « Modifier la mission » only changes the
next runs (HANDOFF §15, PM decision 4); a task already made keeps its subject and its consigne. A
run made before 0027 (`config` NULL) reads the live mission.

## 4b. Objective and completion

`objective` is `{kind, count}`:

| `kind` | Fulfilled when | Use |
|---|---|---|
| `tasks_accepted` (default, `count` null) | every non-cancelled task of the run is `accepted` (a person accepted it, or the agent answered `not_found`) | targeted work: « all these companies are done » |
| `accepted_items` + `count` (1 ≤ count ≤ `result_limit`) | the items a person accepted across the run's tasks reach `count` | discovery, prospection, signals: « 5 new companies » |

Progress is derived from server state (task status, accepted result items), never from an agent's
claim: a submitted-but-unreviewed result counts for nothing. `result_limit` and the objective are
different concepts: the limit caps what a run may *propose*; the objective says when the work is
*done*. That is why a count above `result_limit` is refused (`objective.count`, `range`).

- Each run snapshots the objective (and `allow_multiple`) in `mission_runs.config`; editing the
  mission changes only the next runs, and history is not rewritten. `mission_runs.objective_met_at`
  stamps when that run's objective was first fulfilled.
- **One-off**: when its run's objective is fulfilled, the mission becomes `done`
  (`reason: objective fulfilled`). A run that ends with the objective unmet (a task `failed`, no
  more accepted items) is `done` with the note « Objectif non atteint (n/N) » and the mission stays
  `active`: it never finishes by default.
- **Recurring**: each run gets a fresh objective instance from the current rule. Fulfilling it
  stamps the run and nothing else: the mission keeps its `next_run_at` and closes only by the
  existing end rule (`ends_at` / `max_runs`).
- Settling happens when a result is accepted (`agent_review.accept`) and on every
  `refresh_run` (scheduler pass, mission card). `GET /api/missions/{id}` answers
  `objective_progress` (latest run: `kind`, `target`, `current`, `met`) and `rule.objective` /
  `rule.allow_multiple`.

## 5. What the agent receives

`build_payload` adds a `mission` block to the task payload:

```json
{
  "mission": {
    "id": "…", "name": "Nouveaux entrepôts — Normandie",
    "type": "enrichment", "prompt": "Complète ces fiches…",
    "result_kind": "enrichment", "result_limit": 20,
    "allow_multiple": false, "objective": {"kind": "tasks_accepted", "count": null},
    "geography": "Normandie", "period_days": 30, "exclusions": {"known_companies": true}
  }
}
```

The payload also carries `output_contract` and `objective` (`agent-missions.md` §7.4).

`thread` is `null` for a mission task. The rest of the payload (subject, current values, missing
fields, `output_schema`, lease) is unchanged, so the agent loop is the same as
`agent-missions.md` §8. `update_employee` now has its payload too (person + company + sources +
search hints), which makes prospect enrichment claimable.

## 6. Evidence

Evidence is part of the result, not an afterthought: every `CompanyUpdateResult` /
`EmployeeUpdateResult` carries `confidence`, `evidence[{field, source, quote, confidence?, source_published_at?, source_checked_at?}]` (the last three nullable, per item: `mission-telemetry.md` §9; copied onto each proposal item), and the review card
shows the source next to each proposed value. For a mission, the agent must quote a public URL; a
value without a source is still reviewable but visibly unsourced.

Signals add `observed_on`, `source_channel`, `score_reason`, `relevance`, `valid_until` and a
`SignalKind` (site events included: `facility_opening`, `facility_expansion`, `construction`, `relocation`); the same rule holds: no signal without a dated, public source. A signal about a named
person is resolved against the company's prospects; an unresolved name stays company-level and the
review shows it as such.

## 7. API

| Route | Purpose |
|---|---|
| `GET /api/missions` | cards: name, type, status, agent, recurrence, targets, last/next run, pending results |
| `POST /api/missions` | (also `allow_multiple`, `objective{kind,count}`, §4b) create: active, its first run and tasks created at once unless it starts later (`run_now` is kept for the MCP tool) |
| `GET /api/missions/{id}` | detail: targets, runs, tasks, consigne, expected result |
| `PATCH /api/missions/{id}` | « Désactiver » / « Activer » (the switch on the card, the button on the page; `paused` / `active`) / close. Activating a mission that never ran creates its first run. Pause hides the mission's pending tasks from the agents' queue and claims (a claimed task may finish); resume offers them again. Cancel, in the same transaction, sets every open task (pending, claimed, submitted) to `cancelled` (`agent_task.cancelled`, reason `mission_cancelled`), rejects a result still waiting for review, and sets every `scheduled` / `running` run to `cancelled`; a worker still holding a task is refused with `task_cancelled` |
| `PUT /api/missions/{id}` | « Modifier la mission » (page de la mission, or the list's right-click / « … » menu): the whole rule, linked data included, is rewritten (`mission.updated` with the changed fields); runs already made and their tasks stay as they are (each run keeps its rule, §4), the next run follows the new rule; a done or cancelled mission is refused (409). The detail answers the rest of the rule (`rule`: agent, start, end, geography, period, exclusions) to prefill the form |
| `DELETE /api/missions/{id}` | « Supprimer la mission » (after a confirmation): its open tasks (pending, claimed, submitted) are cancelled (`agent_task.cancelled`, reason `mission_deleted`) and a result still waiting for review is rejected with the same reason, then the mission goes with its targets and runs (FK cascade); the tasks stay with `run_id` NULL; results already accepted are not undone (`mission.deleted`) |
| `GET /api/missions/creator-prompt` | the mission-creator assistant's behaviour prompt: `{prompt, default, is_default, source}` (§7c) |
| `GET /api/missions/options` | types/result kinds with their `executable` flag, units, limits |
| `GET /api/missions/agents` | labels and scopes of the live MCP tokens (never the token itself) |
| `GET /api/missions/targets?kind=&q=` | the linked-data picker |

Results keep their existing surface (`/api/agents/results/{id}`, accept/reject): a mission task is
reviewed exactly like a legacy one.

## 7b. Supervision and telemetry

A run also has **agent sessions** and an append-only **activity log** (who works on it, what was
searched, opened, observed, verified), opened automatically when an agent claims a mission task and
closed after 3 hours without activity. This is observation only: it never changes tasks, leases or
results, and a result is still accepted by a person. Contract, read routes
(`/api/missions/{id}/sessions`, `/activity`, …) and the factual research-report policy:
[`mission-telemetry.md`](mission-telemetry.md). *All of it is shipped: persistence, MCP tools, read
routes and the Mission page below.*

**Mission page (shipped).** `/missions/:id` is a supervision page, not a one-page form: header and
actions, a live strip (agents active now, last activity, `finished/total` progress, reviews waiting,
the API's warnings such as timed-out sessions), then four tabs, URL-synced with `?tab=` (overview =
no parameter): **Vue d'ensemble** (consigne, linked data, runs, tasks), **Activité** (agent sessions +
the factual log, filters, cursor pagination), **Résultats** (review queue; a card opens the review
dialog) and **Statistiques** (KPIs and UTC bucket charts). The live strip and the sessions poll while
the browser tab is visible. In the review dialog the rejection reason field appears only after
« Rejeter »; accepting never asks for one, and a decision is still the only way a proposal changes
business data. The French status and event-type wording lives in one module
(`frontend/src/missions/vocabulary.ts`: singular for badges, plural for counts).

## 7c. Categories, skills and inheritance

*Task `viper_mission_agent_configuration_v2`, Slice 01. Migration `0047`.*

**Why two vocabularies.** What a person picks and sees is a **category** (admin-managed rows); how
VIPER executes it is the technical `MissionType`. A category carries an immutable `mission_type`
chosen at creation; `Mission.type` is copied from it, so editing the taxonomy never re-routes a
mission and no routing code reads the category.

**Tables.** `mission_categories` (name unique per organisation case-insensitively, description, `icon`
= a glyph key such as `shield-check`, `color` = `#rrggbb`, `general_prompt`, `mission_type`,
`position`, `key`), `mission_skills` (name, description, `content` = instruction text),
`mission_category_skills` (ordered default skills of a category; a skill is reusable by many
categories) and `mission_skill_links` (a mission's own list, written only while `skills` is
overridden). Skills are **instruction text only**: no tool or capability is granted through them.

**Seeds and backfill.** The five built-in categories (`key` = `prospection`, `signals`,
`enrichment`, `verification`, `other`) are seeded for CIRCOE. Every pre-existing mission points to the
category of its `type` and keeps its own consigne (`overridden_fields = ['prompt']`), so a later
category edit never rewrites it. A built-in category is edited but never deleted; a created category
is deleted only when no mission uses it (409 `in_use`, `usage.missions`). Deleting a skill detaches
it everywhere (audit reason says how many places).

**Inheritance (field level, explicit).** Inheritable fields: `prompt`, `skills` and (Slice 02, §7d) `sources`.
`missions.overridden_fields` records which ones a person set; it is never inferred by comparing texts.

| Action | Result |
|---|---|
| create with `category_id`, no `prompt` / `skill_ids` | prompt copied from the category, skills follow its defaults |
| create / edit with a `prompt` (or `skill_ids`) | override: the field stays what was sent, even if equal to the category text |
| edit sending `null` | back to following the category (prompt re-copied, own skill links dropped) |
| edit omitting the field | state and value kept |
| edit resubmitting an *inherited* field unchanged | stays inherited (a form sends the whole rule) |
| category `general_prompt` edit | rewrites `missions.prompt` of the missions whose `overridden_fields` lacks `prompt` (one `mission.updated` event each, reason `category default propagated`); overriding missions are untouched; runs keep their own snapshot (§4) |
| category default skills edit | nothing is written: inheriting missions read the live defaults |

`category_id` and `type` on save: a `category_id` gives the type (a contradicting `type` is 422
`category_mismatch`); a bare `type` (legacy form, MCP agents) resolves to the built-in category of
that type; on edit, naming neither keeps the current category. The effective skills of a mission are
`mission_categories.effective_skills(session, mission)` (Slice 07 injects them into the payload;
they are not in the payload yet).

**Read models.** The card carries `category: {id, key, name, icon, color}` (stable visual identity;
no longer hashed from the mission id once Slice 05 renders it); the detail adds `inheritance`
(`category_id`, `overridden_fields`, `prompt_inherited`, `skills_inherited`, `category_prompt`,
`category_skills`) and `skills` (`[{id, name}]`, the effective list).

**Admin API.** Reads are open to any signed-in person; writes need the platform admin or an
« Organisation » admin (403 `forbidden`). Errors: 404 `not_found`, 422 `invalid` (`field`, `reason`
`format` / `immutable` / `category_mismatch` / `not_found`), 409 `duplicate`, 409 `in_use`, 409
`category_system`. Changes are audited as `mission_category.*` / `mission_skill.*`.

| Route | Purpose |
|---|---|
| `GET /api/mission-categories` / `GET …/{id}` | `{id, key, is_system, name, description, icon, color, general_prompt, mission_type, position, skills[{id,name}], missions_count, created_at, updated_at}` |
| `POST /api/mission-categories` | create (`name`, `description?`, `icon`, `color`, `general_prompt`, `mission_type` required, `skill_ids?`, `position?`) |
| `PUT /api/mission-categories/{id}` | rewrite the editable fields and default skills; `mission_type`, if sent, must equal the stored one |
| `PUT /api/mission-categories/{id}/skills` | `{skill_ids}`: the ordered default skills |
| `DELETE /api/mission-categories/{id}` | 204; refused for a built-in or a used category |
| `GET /api/mission-skills` / `GET …/{id}` | `{id, name, description, content, categories_count, missions_count}` |
| `POST /api/mission-skills`, `PUT …/{id}`, `DELETE …/{id}` | `{name, description?, content}` |

**Mission-creator prompt.** The assistant that helps write a mission draft has its own behaviour
prompt, *distinct from a category's general prompt and from skills* (those instruct the worker).
It follows the `contact_initial_prompt` pattern: the `mission_creator_prompt` field of
`Settings`, editable from the browser (`PUT /api/settings/integrations`, ≤ 8 000 characters, `null` or
empty = default; the integrations answer carries `mission_creator_prompt_default`). Built-in default:
`app.services.mission_creator_prompt.DEFAULT_MISSION_CREATOR_PROMPT`; effective value:
`mission_creator_prompt(settings)`. Read contract for Slices 05/06: `GET /api/missions/creator-prompt`
→ `{prompt, default, is_default, source: ui | env | default}`.

## 7d. Source library, internal context and evidence effectiveness

*Task `viper_mission_agent_configuration_v2`, Slice 02. Migration `0050`. Code:
`app/services/mission_sources.py`, `app/services/mission_context.py`, models in
`app/models/missions.py` (`MissionSource`) and `app/models/mission_sources.py`.*

**Two classes of mission source, never mixed.**

| | External research source | Internal context reference |
|---|---|---|
| What | a reusable website / service the agent searches (LinkedIn, Hunter.io) | a VIPER record (company, prospect) that helps the agent |
| Table | `mission_sources` (+ `mission_source_links`, `mission_category_sources`) | `mission_context_refs` |
| Reaches the agent as | `mission.sources[{url, label}]` | `mission_context.resolve` (Slice 07 wires it into the claim) |
| Can earn an effectiveness counter | yes, through accepted evidence | never |
| Is it a `MissionTarget`? | no | **no**: a target is what a task processes (one task per target); context is supporting data, never a subject and never a write path |

**Library (external).** `mission_sources` keeps its 0046 identity (`url`, exact-URL unique per
organisation, `label`) and gains `description`, `parent_id`, `domain`, `path_prefix`,
`successful_uses`. One level only: a **root** (`parent_id` null: LinkedIn) and optional
**sub-sources** (LinkedIn > Jobs, `path_prefix=/jobs`). `domain` = host lower-cased without `www.`
and port; `path_prefix` = path without trailing slash (query/fragment never identify a source).
Adding a URL with no `parent_id` files it under the existing root of its site that covers it, else it
is a root and adopts the childless top-level sources it covers. A cited URL **rolls up** to the most
specific entry that covers it (`resolve_source`: subdomains and deeper paths match, longest domain then
longest path prefix wins); a URL that matches nothing is evidence, not a new library row (no spam).
Deleting a root that still has sub-sources is 409 `in_use` (`usage.sub_sources`).

**Defaults and inheritance (reuses Slice 01).** `sources` joins `INHERITABLE_FIELDS`. A category lists
default sources (`mission_category_sources`, ordered); a mission follows them until `sources` is in
`Mission.overridden_fields`, when its own `mission_source_links` win. `MissionIn.source_ids`:
`null` = follow the category (and drop an earlier override), a list (possibly empty) = override, omitted on
« Modifier » = state kept; resubmitting the inherited list unchanged stays inherited.
`mission_sources.effective_sources(session, mission)` is the one reading; the claim's `mission.sources`
(`agent_payloads.mission_rule`) uses it. A category default edit writes nothing to missions (live read).
Migration: every mission that already had links gets `sources` in `overridden_fields`, so its list keeps
winning.

**Evidence and effectiveness.** *Successful contribution* = a result item **accepted by a person**
that cites a URL the library covers. `agent_review.accept` calls
`mission_sources.credit_accepted_result(session, result, task, accepted_keys)`, which, for each accepted
item only:

1. reads the item's cited URLs from the raw result with the Slice 04 `Evidence` shape (`update_*`: the
   `evidence[]` entries whose `field` is the item's; `find_employees` / `find_prospects`: the `evidence`
   of the person / company at the item's index; `surveil_signals`: the signal's `source`); free text
   that is not an http(s) URL is skipped;
2. stores each distinct URL in `mission_evidence_citations` (`result_id`, `item_key`, `field`, `url`,
   `quote`, `confidence`, `source_published_at`, `source_checked_at`, `source_id`, `mission_id`), unique
   per (result, item, url): the **concrete URL is always kept**, even when the library shows only its
   root / sub-source;
3. credits each distinct library source it resolves to **once** for the (result, item) in
   `mission_source_contributions` (unique source/result/item) and recomputes
   `MissionSource.successful_uses` from that ledger.

So a fact supported by three sources credits all three once; two LinkedIn URLs for one item credit the
root once; a rejected, pending or non-accepted item credits nothing; `source_opened` telemetry never
counts; resubmission, rebuild or calling the function again stores nothing twice
(`refresh_counters` can rebuild every counter). `rolled_up_uses` of a root = distinct accepted items
credited to it or its sub-sources. Deleting a source cascades its ledger and nulls the `source_id` of
its citations. Not recorded: staged `actions` proposals (tool mode) carry no per-item evidence yet.

**Internal context.** `mission_context_refs(mission_id, company_id | prospect_id, note)`: typed FKs for
the allowlist `CONTEXT_KINDS = (company, prospect)` (a new kind = a new column + serializer; there is no
generic table/SQL selector), unique per mission and record, at most 50, a deleted record cascades away.
`mission_context.resolve(session, mission_id)` is the runtime contract: it reads the records **now** and
serialises a fixed allowlist, each text clipped, read-only:
`[{kind, id, label, note, read_only: true, fields}]`. Company fields: `legal_name`, `siren`,
`website_url`, `email_domain`, `size_label`, `commercial_segment`, `activity_categories`, `sites[≤5]`
(`name`, `city`, `postal_code`). Prospect fields: `exact_job_title`, `role`, `activity_status`, `company`.
Deliberately **excluded**: the Circoe-internal company notes (`project_done_with_circoe`, `project_type`,
`circoe_references`, `client_approach`) and every contact channel of a person (e-mails, phones,
do-not-contact data): widening the allowlist is a conscious code + doc change.

| Route | Purpose |
|---|---|
| `GET /api/missions/sources` | library, flat: `q`, `parent_id`, `roots_only`, `min_successful_uses` (roll-up), `order=recent\|name\|uses`; rows `{id, url, label, description, domain, path_prefix, parent_id, children_count, successful_uses, rolled_up_uses, missions_count, categories_count, created_at}` |
| `POST /api/missions/sources` | `{url, label?, description?, parent_id?}` (open to any signed-in person: the mission form saves links; 422 `too_deep` / `domain` / `not_found` on a bad parent) |
| `GET / PATCH / DELETE /api/missions/sources/{id}` | read; edit `label`, `description`, `parent_id` (`null` = make it a root; **admin**); forget (409 `in_use` for a root with sub-sources) |
| `GET /api/missions/sources/{id}/citations?limit=` | the concrete cited URLs behind a source and its sub-sources, newest first |
| `PUT /api/mission-categories/{id}/sources` | `{source_ids}`: ordered default sources (**admin**); `CategoryOut.sources[{id,url,label}]`; `source_ids` on `POST/PUT` category is also accepted (omitted on `PUT` = kept) |
| `GET /api/missions/context-candidates?kind=company\|prospect&q=` | search the records that may be linked as context (same shape as `/targets`) |
| `GET /api/missions/{id}/context` | what the agent would receive now (resolved, allowlisted) |
| `POST /api/missions/{id}/context` | `{kind, id, note?}` link one record (idempotent; 404 unknown record, 422 unknown kind) |
| `DELETE /api/missions/{id}/context/{kind}/{record_id}` | unlink (404 when not linked) |

Mission create / edit also take `context_refs: [{kind, id, note?}]` (replace-all; omitted on edit = kept).
`GET /api/missions/{id}` answers `sources` (the effective external sources, same row shape as the library),
`context_refs[{kind, id, label, hint, note}]` (distinct from `targets`) and
`inheritance.sources_inherited` / `inheritance.category_sources`. Known gap for Slice 05/07: the current
create dialog always sends `source_ids` (an array), which counts as an override; Slice 05 sends `null` to
follow category defaults, and Slice 07 puts `mission_context.resolve` and the effective skills in the claim.

## 8. Phases

1. **Shipped** — model, API, page, modal, linked data, enrichment/verification runs, agent
   assignment, run detail, review.
2. **Discovery and signals** — *shipped for storage:* `find_employees`, `find_prospects` and
   `surveil_signals` all complete (dedup, required public source, acceptance). Accepted signals are
   dated `prospect_notes` rows. Person signals count in the prospect's score at full value; company
   signals count in a **capped subtotal** (±30, `prospect_score.COMPANY_SIGNAL_CAP`) so an account
   fact cannot drown what the person said. The review card has its signal board and the company page
   lists its signals.
3. **Shipped** — the scheduler (`app/services/mission_scheduler.py`) runs every 60 s, locks due
   missions `SKIP LOCKED`, honours `ends_at` / `max_runs`, closes an exhausted mission, and pauses a
   mission whose type cannot execute (a scheduled signals mission does not retry forever).
4. **Polish** — *shipped:* review signal board (kind, subject, date, score, relevance, source),
   company signals on the company page (`GET /api/companies/{id}/signals`) and the capped company
   score contribution. Still to do: mission edit, per-run re-run, retention.

## 9. Open questions

1. ~~Can a mission be edited after its first run?~~ Yes (`PUT`), except once done or cancelled.
2. Who may launch a mission assigned to an agent that is currently offline?
3. Should a recurring mission stop itself when a run fails, or keep trying?
4. `find_prospects` output: companies first, or people directly? (See `agent-missions.md` §15.4.)

## 7e. Administration UI, grouped navigation and the mission form

*Task `viper_mission_agent_configuration_v2`, Slice 05. Front only; code in `frontend/src/admin/`,
`frontend/src/missions/` and `frontend/src/shell/navigation.ts`.*

- **Sidebar** (`shell/navigation.ts`, `NAVIGATION_SECTIONS`): *Principal* (Accueil, Prospection, Entrepôts, Missions,
  Agenda, Base de données), *Configuration* (Organisation, Historique agents, Paramètres), *Administration*
  (Catégories, Skills, Sources; shown only to the platform admin or an « Organisation » admin, same rule as the API's
  `require_admin`). Routes `/administration/:section` (`categories` | `skills` | `sources`) are guarded by
  `auth/RequireAdmin` (anyone else is sent to Accueil); the API still checks every write.
- **Administration.** *Catégories*: one-page editor (name, immutable execution type, description, icon, colour, general
  prompt, default skills, default sources); a built-in or used category cannot be deleted (the button says why).
  *Skills*: instruction blocks only. *Sources*: root > sub-sources tree with the **successful-use** count (accepted
  items supported; a root shows its roll-up), edit/delete with the server's `in_use` refusal shown in the dialog.
- **Mission form** (`CreateMissionDialog`, state in `useMissionForm`). The category tiles carry the category's icon and
  colour. `prompt`, `skill_ids` and `source_ids` are sent as **`null` while the mission follows its category** and as a
  value once overridden; an `Hérité` / `Personnalisé` note with a reset button shows which. An empty consigne field means
  « use the category's general prompt » (shown as the placeholder). Internal context records (`context_refs`, read-only,
  searched through `/missions/context-candidates`) are a separate section from the linked data (`targets`). Execution:
  *Une fois / Récurrente* with the existing recurrence fields, `objective` (`tasks_accepted` | `accepted_items` + count
  <= `result_limit`) and `allow_multiple`.
- **Visual identity.** Mission cards and the detail header take icon and colour from `card.category`
  (`missions/categoryVisual.ts`), not from the id; status keeps its own semantic chip.
- **Mission-creator prompt.** Paramètres › *Assistant de mission* (`/settings/mission-creator`) edits
  `mission_creator_prompt` with the same editor and reset-to-default rule as the contact prompt.
- **Slice 06 seam.** `CreateMissionDialog` takes `initialDraft` and `assistantSlot(form)`; the form API
  (`useMissionForm`) exposes `applyDraft(MissionDraft)` and `toInput()`.

