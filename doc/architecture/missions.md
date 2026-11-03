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
| `type` | `prospection`, `signals`, `enrichment`, `verification`, `other` |
| `prompt` | the consigne, verbatim; never copied into a task |
| `agent_id` / `agent_label` | `NULL` = « Automatique »: any agent with the scope may claim; the label is snapshotted |
| `is_recurring`, `interval_count`, `interval_unit` | ponctuelle, or every N hours/days/weeks/months |
| `starts_at`, `end_kind`, `ends_at`, `max_runs` | now or a date; never / at a date / after N runs |
| `result_kind`, `result_limit` | what is expected, and the cap per run |
| `geography`, `period_days`, `exclusions` | advanced filters, passed to the agent in the payload |
| `next_run_at`, `last_run_at` | derived scheduling state |

**Two modes, one type vocabulary.** A mission with no target is a *discovery* mission; a mission
with linked records is a *base-work* mission. That is why there is no `discovery` type next to
`enrichment`: the linked data says which mode it is, and the modal stays at six visible fields.

## 3. Linked data

`mission_targets` stores `(mission_id, company_id | prospect_id)`, exactly one subject per row,
with a unique pair per mission. The consigne is never a copy of the record: the agent re-reads the
live company/prospect when it claims the task, so a mission written on Monday works on Friday's row.

The modal's « + Ajouter des données » behaves like an attachment: a search by type (Sociétés /
Prospects), multiple checkboxes, then chips (`Transports X × Jean Dupont × +11`). The picker reuses
`companies.list_companies` and `GET /api/missions/targets?kind=prospect&q=`.

## 4. Runs and tasks

`POST /api/missions/{id}/run` (and « Créer et lancer ») creates a `mission_runs` row and one task per
target:

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

## 5. What the agent receives

`build_payload` adds a `mission` block to the task payload:

```json
{
  "mission": {
    "id": "…", "name": "Nouveaux entrepôts — Normandie",
    "type": "enrichment", "prompt": "Complète ces fiches…",
    "result_kind": "enrichment", "result_limit": 20,
    "geography": "Normandie", "period_days": 30, "exclusions": {"known_companies": true}
  }
}
```

`thread` is `null` for a mission task. The rest of the payload (subject, current values, missing
fields, `output_schema`, lease) is unchanged, so the agent loop is the same as
`agent-missions.md` §8. `update_employee` now has its payload too (person + company + sources +
search hints), which makes prospect enrichment claimable.

## 6. Evidence

Evidence is part of the result, not an afterthought: every `CompanyUpdateResult` /
`EmployeeUpdateResult` carries `confidence`, `evidence[{field, source, quote}]`, and the review card
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
| `POST /api/missions` | create, with `run_now` for « Créer et lancer » |
| `GET /api/missions/{id}` | detail: targets, runs, tasks, consigne, expected result |
| `PATCH /api/missions/{id}` | pause / resume / close |
| `PUT /api/missions/{id}` | « Modifier la mission » (page de la mission, or the list's right-click / « … » menu): the whole rule, linked data included, is rewritten (`mission.updated` with the changed fields); runs already made and their tasks stay as they are (each run keeps its rule, §4), the next run follows the new rule; a done or cancelled mission is refused (409). The detail answers the rest of the rule (`rule`: agent, start, end, geography, period, exclusions) to prefill the form |
| `DELETE /api/missions/{id}` | « Supprimer la mission » (after a confirmation): its open tasks (pending, claimed, submitted) are cancelled (`agent_task.cancelled`, reason `mission_deleted`), then the mission goes with its targets and runs (FK cascade); the tasks stay with `run_id` NULL; results already accepted are not undone (`mission.deleted`) |
| `POST /api/missions/{id}/run` | « Lancer maintenant » |
| `GET /api/missions/options` | types/result kinds with their `executable` flag, units, limits |
| `GET /api/missions/agents` | labels and scopes of the live MCP tokens (never the token itself) |
| `GET /api/missions/targets?kind=&q=` | the linked-data picker |

Results keep their existing surface (`/api/agents/results/{id}`, accept/reject): a mission task is
reviewed exactly like a legacy one.

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
