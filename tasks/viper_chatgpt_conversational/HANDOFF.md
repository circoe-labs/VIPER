# VIPER x ChatGPT - Implementation Handoff

## 1. Purpose

This handoff defines the work required to turn VIPER's current MCP integration from a worker-oriented execution interface into a complete conversational interface usable by a signed-in ChatGPT user, while preserving the existing mission/task/review model and human control over sensitive actions.

The target outcome is that a user can ask ChatGPT natural-language questions and requests such as:

- "Combien ai-je de prospects ?"
- "Quels nouveaux prospects ont ete ajoutes cette semaine ?"
- "Quels mails sont encore en brouillon ou en attente de validation ?"
- "Cree une mission pour trouver les nouveaux entrepots construits en Normandie ces 90 derniers jours."
- "Passe cette veille en hebdomadaire."
- "Lance la mission maintenant."
- "Quelles propositions d'agents attendent une validation ?"

The same VIPER instance must also continue to support autonomous workers, including ChatX agents, ChatGPT workers, and scheduled/recurrent agents, without granting those workers the same privileges as the interactive ChatGPT acting on behalf of a user.

---

## 2. Repository state inspected

Repository: `circoe-labs/VIPER`

Reference state inspected: `main`, commit `699ec3b` (`add missions`, 2026-11-03).

Important existing implementation areas:

- `backend/app/api/mcp.py`
- `backend/app/models/mcp.py`
- `backend/app/services/mcp_tokens.py`
- `backend/app/models/agent_missions.py`
- `backend/app/services/agent_missions.py`
- `backend/app/services/agent_payloads.py`
- `backend/app/services/agent_review.py`
- `backend/app/services/agent_writes.py`
- `backend/app/models/missions.py`
- `backend/app/services/missions.py`
- `backend/app/api/routes/missions.py`
- `backend/app/api/routes/home.py`
- `backend/app/api/routes/prospection.py`
- `backend/app/api/routes/contact.py`
- `backend/app/api/routes/contact_messages.py`
- `backend/app/api/routes/search.py`
- `backend/app/models/companies.py`
- `doc/architecture/mcp-server.md`
- `doc/architecture/agent-missions.md`
- `doc/architecture/missions.md`

The implementation is already beyond the old V1 description in the root README: missions, agent discovery, signals, recurrence, and result review are already present in code.

---

## 3. Existing architecture that must be preserved

VIPER already has the correct execution hierarchy:

```text
Mission
  -> Run
      -> AgentTask
          -> AgentTaskResult
              -> Human review
                  -> Domain write
```

This hierarchy must remain the canonical model.

### Mission

A mission is the user-facing persistent instruction. It already supports:

- `name`
- `type`
- `prompt`
- optional linked companies/prospects
- optional assigned agent
- recurrence
- start/end rules
- expected result kind
- result limit
- geography
- period window
- exclusions
- current/next run metadata

### Run

A run is one execution of a mission, manual or scheduled.

### AgentTask

An `AgentTask` is an internal execution unit. It is leased to a worker through MCP, with `claim_id`, heartbeat, expiry, attempts and concurrency control.

### Result

Workers never directly mutate the domain. They submit a result which becomes a reviewable proposal.

### Human review

Accepted results are applied through the normal company/prospect/signal services with the reviewing human as the deciding actor.

This design is a core invariant and should not be weakened for ChatGPT integration.

---

## 4. Key product decision: ChatGPT creates missions, not raw tasks

The interactive ChatGPT must not receive a generic `create_task` primitive.

Tasks are an execution detail owned by VIPER. The conversational layer should create and manage missions, and VIPER should derive the necessary tasks from the mission configuration.

Correct flow:

```text
User request
  -> ChatGPT interprets and structures intent
      -> viper_create_mission
          -> VIPER creates Mission
              -> VIPER creates Run when requested/scheduled
                  -> VIPER creates AgentTask rows
                      -> workers claim tasks
```

This avoids inconsistent task graphs, bypassing mission scheduling rules, and exposing internal orchestration concepts to end users.

---

## 5. Agent identity: reuse the existing concept, but separate principal from credential

### Current state

`McpToken` already provides:

- a UUID
- a label
- scopes
- max concurrent task count
- `last_used_at`
- revocation state

`mcp_tokens.actor_for()` converts the token record into an `ActorContext(type=AGENT, id=<token id>, display=<label>)`.

A mission can already carry an `agent_id`, and generated tasks can be restricted to that agent.

Therefore, there is no need to add a self-declared ChatGPT identifier inside a skill or request payload.

### Problem

The current model effectively makes the credential row the agent identity. Rotating a token may therefore imply rotating identity, which is undesirable when audit history should keep referring to the same logical agent.

### Recommended target model

Introduce a stable agent principal separate from credentials.

```text
AgentPrincipal
- id UUID
- label
- provider            # chatgpt | chatx | other
- mode                # interactive | worker | scheduled
- owner_user_id       # nullable
- enabled
- capabilities        # server-side permissions
- created_at
- updated_at

AgentCredential
- id UUID
- principal_id
- token_hash
- created_at
- last_used_at
- revoked_at
```

The exact names may differ, but the separation is important.

### Identity dimensions

Do not model only "ChatGPT" versus "ChatX". Keep at least two independent dimensions:

- provider: which platform/runtime is calling VIPER;
- mode: what role the current agent is performing.

Examples:

```text
provider=chatgpt, mode=interactive
provider=chatgpt, mode=worker
provider=chatgpt, mode=scheduled
provider=chatx,   mode=worker
```

---

## 6. Authorization model

Authentication remains necessary.

The skill is behavioral guidance, not an authorization boundary. A statement such as "workers must not create missions" inside a skill is useful but not sufficient.

VIPER must enforce permissions server-side.

### Recommended profiles

#### Interactive assistant

Acts on behalf of a signed-in user.

Typical capabilities:

- read companies/prospects/establishments
- read dashboards and KPIs
- read contact state
- read missions and pending proposals
- create missions
- run missions
- pause/resume/cancel missions according to policy
- optionally draft/update contact messages

#### Worker

Runs autonomous mission tasks.

Typical capabilities:

- queue count
- claim task
- heartbeat
- read task context
- perform record lookups required for the task
- submit result
- fail/release task

Must not:

- create missions
- accept its own result
- modify mission configuration
- directly apply results to the domain
- bypass review

#### Scheduled assistant

May be more privileged than a worker but should still receive a narrow server-side capability set. Do not assume a scheduled ChatGPT should inherit all interactive-user capabilities.

### User delegation

Once user/admin/super-admin support is available, effective permissions for an interactive assistant should be derived from both:

```text
user permissions INTERSECT agent capabilities
```

Audit should be able to distinguish:

- the human user whose authority is being used;
- the agent principal performing the action;
- the action source.

Preferred audit semantics are conceptually:

```text
ChatGPT agent X acting for user Y
```

rather than falsely recording every agent-mediated write as a direct manual action by Y.

---

## 7. MCP gap: current surface is worker-oriented

The current MCP surface primarily exposes:

- task claim/heartbeat/submit/fail/release
- queue counts
- company list/detail
- prospect list/detail
- tool-mode proposal of company/prospect updates

This is enough for workers and limited assistant enrichment, but not enough for a full conversational VIPER assistant.

The main work is to expose existing domain services through a controlled conversational MCP API.

---

## 8. Required conversational MCP tools

### 8.1 Identity and capabilities

#### `viper_whoami`

Purpose:

- return the current stable agent identity;
- provider/mode;
- delegated user when applicable;
- effective capabilities;
- optional server/product version.

This avoids relying on a model-declared identity.

---

### 8.2 Global search

#### `viper_search`

Wrap the existing global search service used by `GET /api/search`.

Should return typed results for:

- prospects
- companies
- establishments

This becomes the primary conversational lookup primitive before asking for a detail record.

Examples:

- "Trouve Renault Trucks."
- "Cherche Dupont chez X."
- "Est-ce qu'on a deja un etablissement a Honfleur ?"

---

### 8.3 Dashboard and commercial metrics

Do not expose generic SQL to ChatGPT.

Instead expose canonical product metrics backed by existing services.

#### `viper_get_dashboard`

Wrap the home dashboard summary.

Useful data includes:

- prospect segment counts
- company count
- incomplete/unverified/email-error figures
- contact progress
- appointment progress
- current week's due actions
- recent activity

#### `viper_get_prospection_metrics`

Wrap the canonical prospection overview/counters.

Support questions such as:

- total prospects
- contacted prospects
- deleted prospects
- segment counts
- review counts
- recent additions/verifications where already represented by canonical counters

If "new prospects in the last N days" is not currently a first-class metric, implement a dedicated read model/service rather than giving the assistant SQL access.

---

### 8.4 Missions

#### `viper_list_missions`

Return mission cards and optionally filter by status/type/agent.

#### `viper_get_mission`

Return:

- configuration
- targets
- runs
- tasks
- pending results
- last/next execution

#### `viper_create_mission`

This is the key interactive tool.

Input should mirror the existing `MissionIn` contract:

- name
- type
- prompt
- targets
- agent id optional
- recurrence
- start/end policy
- expected result
- result limit
- geography
- period
- exclusions
- run now

No confirmation is required merely because a mission is being created, unless the user's intent/configuration is materially ambiguous.

#### `viper_run_mission`

Manual "run now".

#### `viper_set_mission_status`

Support at minimum:

- pause
- resume/active
- cancel
- done/close if product semantics require it

Cancellation/deletion-like actions must be treated as destructive and should require explicit user confirmation according to host/tool policy.

#### `viper_update_mission`

This requires new domain support because the current REST patch only updates status.

At minimum allow controlled edits to:

- name
- prompt
- agent
- recurrence
- starts/ends rules
- expected result
- result limit
- geography
- period
- exclusions
- targets

Define rules for missions that already have completed or in-flight runs. Prefer immutable historical runs and new configuration only for future runs.

---

### 8.5 Pending agent proposals

#### `viper_list_pending_reviews`

Expose pending review results from mission/tool mode.

Should provide enough information for the assistant to answer:

- how many results are waiting;
- which mission/task/company/prospect they concern;
- who submitted them;
- when;
- a short digest.

A later phase may expose accept/reject actions, but these should remain separately permissioned and explicitly reviewed.

---

### 8.6 Contact workflow reads

Existing backend contact APIs already contain the data needed for conversational assistance.

Add:

#### `viper_get_contact_overview`

Return current contact workload:

- due now/this week
- overdue
- drafts
- validated
- scheduled
- forgotten/unprogrammed
- dispatch state/errors

#### `viper_get_prospect_messages`

Return the contact sequence for one prospect:

- steps
- status
- recipients
- subject/body
- validation state
- schedule
- errors
- sent state

This enables:

- "Quels mails me restent a traiter ?"
- "Montre-moi les brouillons a valider."
- "Pourquoi le mail de Dupont n'est pas parti ?"

---

## 9. Contact write capabilities - phased rollout

The existing product explicitly maintains human control over validation and sending. Preserve that default.

### Phase 1

Read-only contact tools.

### Phase 2

Allow:

- generate draft
- update draft content

Potential tools:

- `viper_generate_contact_draft`
- `viper_update_contact_draft`

These should remain drafts.

### Later phase

Potentially expose:

- validation
- scheduling
- unscheduling
- cancellation
- sending-related actions

Only after defining user roles, capabilities, audit semantics and confirmations.

A worker agent must never inherit these capabilities simply because it can submit prospecting results.

### Routing rule

When the message belongs to VIPER's commercial contact workflow, ChatGPT should prefer VIPER over a generic mail connector so that sequence state, validation state and audit remain coherent.

Generic mail tooling remains appropriate for unrelated office email work.

---

## 10. Major domain gap revealed by "new warehouses in Normandy"

The current discovery result model can find and propose new companies, but it does not cleanly preserve the business event that caused the company to be discovered.

Current `CompanyProposal` contains fields such as:

- display/legal name
- SIREN
- website
- email domain
- size
- commercial segment
- activity categories
- confidence
- evidence
- notes

This is insufficient for a discovery request like:

"Find companies associated with warehouses newly built/opened in Normandy."

The valuable information is not only the company. It is also:

- the facility;
- its location;
- its type;
- opening/construction/extension date;
- surface if known;
- the source;
- the dated commercial trigger;
- why the trigger matters.

VIPER already has an `Establishment` model with name, SIRET, address, city, country, kind and primary flag. `kind` is already open-ended and can represent "warehouse".

### Recommended extension to discovery proposals

Extend company discovery to support establishment and trigger information.

Conceptual shape:

```json
{
  "display_name": "Example Logistics",
  "legal_name": "Example Logistics SAS",
  "siren": "...",
  "website_url": "...",
  "establishments": [
    {
      "name": "Plateforme de Honfleur",
      "kind": "entrepot",
      "siret": "...",
      "address_line1": "...",
      "postal_code": "...",
      "city": "Honfleur",
      "country": "FR",
      "opened_on": "2026-09-12",
      "surface_m2": 18000,
      "source": "https://..."
    }
  ],
  "trigger": {
    "kind": "facility_opening",
    "observed_on": "2026-09-12",
    "description": "Ouverture d'un nouvel entrepot de 18 000 m2.",
    "source": "https://...",
    "relevance": 90,
    "score_reason": "Nouvelle implantation logistique exploitable commercialement."
  }
}
```

Exact schema should be aligned with existing Pydantic evidence/signal types rather than duplicated unnecessarily.

### Signal taxonomy

Consider adding dedicated signal kinds such as:

- `facility_opening`
- `facility_expansion`
- `construction`
- `relocation`

If the existing signal model intentionally stays generic, use `other` initially but preserve a structured sub-kind. The important requirement is to avoid losing the trigger in unstructured `notes`.

### Acceptance path

When a reviewer accepts a discovery result, VIPER should be able to create, in one coherent reviewed transaction where applicable:

1. the company;
2. the establishment;
3. the commercial signal/trigger;
4. provenance/source references.

This preserves the reason the company entered the pipeline.

---

## 11. Skill: `viper-use`

Create a dedicated usage skill for VIPER.

The skill must not duplicate the entire API schema. Tool descriptions remain the source for exact parameters. The skill should encode routing and behavior by scenario.

### Trigger scope

Use VIPER when the user asks about:

- companies in the commercial database
- prospects/contacts
- establishments
- commercial qualification/enrichment
- prospecting missions
- commercial signals/monitoring
- contact workflow status
- prospecting KPIs
- agent results awaiting review

### Mode A - Interactive user assistant

Rules:

- prefer VIPER for commercial/prospecting data;
- answer questions from VIPER rather than guessing;
- convert natural-language work requests into missions;
- create a mission rather than raw tasks;
- infer obvious parameters from the user's request;
- ask only when a material configuration is ambiguous;
- for recurring VIPER work, prefer VIPER's native mission recurrence;
- clearly distinguish proposed data from accepted/applied data;
- request confirmation for destructive actions according to tool policy;
- do not expose or request raw SQL for ordinary user questions.

### Mode B - Mission worker

Rules:

- claim a task;
- obey the returned mission/task payload;
- use the exact output schema;
- perform heartbeat when necessary;
- collect public evidence;
- never guess missing values;
- submit a result;
- release/fail when appropriate;
- never create/edit/cancel missions;
- never accept its own proposal;
- never bypass human review.

### Mode C - Scheduled assistant

Rules:

- obey server capabilities;
- do not assume interactive-user privileges;
- prefer VIPER mission recurrence for recurring VIPER work;
- do not perform destructive actions unless explicitly permitted and confirmed.

---

## 12. Update the CIRCOE routing skill

Update the CIRCOE global routing guidance so VIPER is discoverable whenever company/prospecting context is involved.

Recommended routing model:

```text
IGuard
  -> internal CIRCOE knowledge, processes, projects, clients, decisions, documentation

CIRCOE Toolbox
  -> office tooling: mail, calendar, contacts, files, documents, generic operational actions

VIPER
  -> B2B prospecting and commercial data: companies, establishments, prospects, enrichment,
     signals, missions, contact workflow, prospecting KPIs
```

Important contact exception:

If an email is part of a VIPER prospecting/contact sequence, prefer VIPER so sequence state remains coherent. Do not bypass it through a generic email connector unless the requested action explicitly belongs outside VIPER's workflow.

---

## 13. MCP metadata and safety annotations

The current tool declarations largely expose name, description and input schema.

Add appropriate MCP tool annotations where supported, especially concepts equivalent to:

- read-only
- destructive
- open-world/external side effect

Example classification:

| Tool | Read only | Destructive | External/open-world |
|---|---:|---:|---:|
| `viper_get_dashboard` | yes | no | no |
| `viper_search` | yes | no | no |
| `viper_get_mission` | yes | no | no |
| `viper_create_mission` | no | no | no |
| `viper_run_mission` | no | no | no |
| `viper_set_mission_status(cancel)` | no | yes | no |
| delete draft | no | yes | no |
| external send action | no | yes | yes |

Annotations are advisory metadata for clients/hosts. They do not replace server-side authorization.

---

## 14. ChatGPT UI for mission creation

A conversational flow is sufficient for initial implementation, but a structured UI would materially improve mission creation and review.

Target interaction:

```text
Nouvelle mission

Trouver les nouvelles implantations logistiques en Normandie publiees ces 90 derniers jours.

Type        Prospection
Zone        Normandie
Periode     90 jours
Resultat    Societes
Maximum     30
Recurrence  Hebdomadaire
Agent       Automatique

[Creer] [Creer et lancer] [Modifier les parametres]
```

Behavior:

1. ChatGPT infers everything that is obvious from the request.
2. The UI displays the structured interpretation.
3. The user edits only what needs correction.
4. Creation is additive and should not require a redundant confirmation when intent is clear.
5. Destructive actions remain separately confirmed.

Do not make the UI mandatory for using the underlying tools. MCP tools must remain usable without the component.

---

## 15. Mission editing semantics

Current API supports mission status changes but not full editing.

Define and implement a full future-run configuration update model.

Recommended invariant:

- completed runs are immutable historical records;
- in-flight runs retain the configuration/payload semantics under which they were created;
- mission edits apply to subsequent runs;
- changing a target list or result kind must not retroactively alter already generated tasks.

If necessary, snapshot additional mission configuration on each run to make this guarantee explicit.

Open product decision:

- whether editing a currently running mission is allowed immediately, delayed until the run ends, or creates a new revision.

Default recommendation: permit editing future configuration while preserving the active run's effective configuration.

---

## 16. Non-goals

Do not implement the following as part of the first conversational integration unless separately approved:

- generic SQL access for ChatGPT;
- direct worker writes to companies/prospects;
- automatic acceptance of worker results;
- generic raw task creation by interactive ChatGPT;
- unrestricted email sending by workers;
- self-declared agent identity from model prompts/skills;
- authorization enforced only by skill instructions;
- replacement of the existing Mission -> Run -> Task -> Result architecture.

---

## 17. Recommended implementation graph

Numbering below is presentation order, not a serial execution mandate.

### Slice 00 - Project manager readiness

Goal:

- independently inspect current repository state;
- reconcile this handoff with current `main`;
- detect overlapping user/admin/auth work already in progress;
- confirm ownership boundaries and migrations;
- declare one state: `READY`, `CONTEXT_REWORK_REQUIRED`, `CONFLICT`, or `HUMAN_DECISION_REQUIRED`.

No implementation dispatch before `READY`.

The PM must not assume commit `699ec3b` is still current at implementation time.

---

### Slice 01 - Agent principal and capability model

Goal:

Introduce stable agent identity and server-side capabilities without breaking existing worker MCP tokens.

Scope:

- separate stable principal from credentials, or implement an equivalent durable identity abstraction;
- provider/mode metadata;
- optional owner/delegated user relationship;
- capability resolution;
- compatibility migration for current `mcp_tokens`;
- `viper_whoami`.

Hard dependency:

- coordinate with active user/admin/super-admin implementation if it changes auth/user schema.

Produces:

- canonical agent identity contract;
- effective capability check usable by every new MCP mutation.

---

### Slice 02 - Conversational read API

Goal:

Expose canonical VIPER read models over MCP.

Scope:

- `viper_search`
- `viper_get_dashboard`
- `viper_get_prospection_metrics`
- mission list/detail
- pending review list
- contact overview
- prospect message/sequence reads

Can start in parallel with Slice 01 by implementing service wrappers against a provisional capability interface, then wire final authorization before integration.

Constraint:

No generic SQL tool.

---

### Slice 03 - Mission conversational actions

Goal:

Allow an interactive assistant to manage missions safely.

Scope:

- create mission
- run mission
- status changes
- full mission update service/API/tool
- target selection/search as needed
- authorization checks
- destructive-action metadata

Requires Slice 01's final capability contract before integration, but most service/tool design can start against a narrow authorization seam.

---

### Slice 04 - Discovery result enrichment: establishments + trigger

Goal:

Make facility-driven prospecting first-class.

Scope:

- extend discovery result schema;
- establishment proposal fields;
- commercial trigger/signal fields;
- normalization and dedup;
- review proposal display data;
- acceptance path creating company + establishment + signal/provenance where accepted;
- add or extend signal taxonomy for facility events.

This Slice is largely independent of conversational MCP work and can run in parallel once the schema approach is agreed.

Potential conflict boundary:

- `agent_payloads.py`
- `agent_review.py`
- company/establishment services
- signal model/taxonomy

---

### Slice 05 - Skills and routing guidance

Goal:

Create the behavior layer used by ChatGPT.

Scope:

- new `viper-use` skill;
- update CIRCOE routing guidance to include VIPER;
- define behavior for interactive, worker and scheduled modes;
- explicitly state that permissions are server-enforced;
- route VIPER contact-sequence mail through VIPER.

Soft requirement:

Exact new tool names/schemas from Slices 02 and 03.

Fallback:

Draft behavior against the tool contract documented in this handoff, then reconcile names during integration.

---

### Slice 06 - Mission creation UI / MCP app surface

Goal:

Add an optional structured ChatGPT UI for mission creation and editing.

Scope:

- mission summary card/form;
- inferred values prefilled;
- create / create-and-run / edit controls;
- validation errors surfaced cleanly;
- no duplicate authorization logic in UI.

Can start from a fixture contract while Slice 03 finalizes the backend tool.

---

### Slice 07 - Contact drafting actions

Goal:

Permit interactive ChatGPT to assist with contact drafts without weakening current validation rules.

Scope:

- generate draft
- update draft
- preserve revision checks
- preserve human validation before send
- server-side capability enforcement

Do not add unrestricted send support in this Slice.

---

### Slice 08 - Integration and final validation

Hard depends on all implementation Slices selected for the release.

Responsibilities:

- reconcile tool contracts and capability checks;
- validate backward compatibility for existing worker agents;
- run complete unit test suite once;
- run integration/E2E tests in the same final validation phase;
- test mission creation through conversational MCP;
- test worker claim/submit flow still works;
- test denied permissions for worker mission creation;
- test warehouse discovery result review and application;
- test contact reads and optional draft writes;
- validate audit attribution;
- validate destructive confirmation metadata/policies;
- validate skills against real tool traces.

Full regression/unit suites belong here rather than at each implementation Slice boundary.

---

## 18. Initial parallel dispatch recommendation

After PM readiness, likely parallel-safe workstreams are:

```text
                 +-> Slice 02 Conversational reads --------+
Slice 00 READY --+-> Slice 01 Identity/capabilities -------+--> Slice 08 Integration
                 +-> Slice 04 Facility discovery schema ---+
                 +-> Slice 05 Skill draft -----------------+

Slice 03 Mission actions requires final capability wiring from Slice 01 before integration.
Slice 06 UI can begin against a fixture/tool contract and reconcile with Slice 03.
Slice 07 Contact draft actions should use Slice 01 capability enforcement before final wiring.
```

Main critical path is expected to be:

```text
00 -> 01 -> 03 -> 08
```

unless the active user/admin implementation becomes a blocker for Slice 01.

---

## 19. Testing and quality rules

### Per implementation Slice

Use lightweight targeted validation only:

- static inspection
- type checking/lint where relevant
- focused compile/build checks
- narrow runtime smoke checks
- real MCP trace for tool/routing work
- code review for code changes

Do not automatically launch the complete unit test suite at every Slice boundary.

### Final convergence

Slice 08 owns:

- full backend unit test suite;
- full relevant frontend unit tests;
- integration tests;
- MCP protocol/tool tests;
- E2E flows;
- migration compatibility checks;
- worker backward compatibility;
- authorization negative tests.

Run unit and E2E campaigns in parallel when environments/resources are isolated enough; otherwise run them within the same final validation phase.

Regressions introduced by a Slice are blocking and must be fixed, not deferred as accepted issues.

---

## 20. Minimum acceptance criteria

The implementation is not complete until all applicable criteria below are satisfied.

### Identity and authorization

- A calling agent has a stable server-resolved identity.
- Interactive, worker and scheduled modes can receive different capabilities.
- Worker agents cannot create/edit/cancel missions without explicit capability.
- Authorization cannot be bypassed by ignoring skill instructions.
- Audit can identify the acting agent and delegated user where applicable.

### Conversational reads

- ChatGPT can answer how many companies/prospects exist using canonical VIPER services.
- ChatGPT can search companies, prospects and establishments.
- ChatGPT can report prospection status and contact workload.
- ChatGPT can inspect mission state and pending proposals.

### Missions

- Interactive ChatGPT can create a mission from a natural-language brief.
- Clear requests do not require redundant confirmation before additive mission creation.
- ChatGPT can run, pause/resume and inspect missions.
- Destructive mission actions are marked/handled appropriately.
- Mission edits affect future execution without corrupting historical runs.

### Worker compatibility

- Existing claim/heartbeat/submit/release/fail behavior still functions.
- Assigned-agent restrictions still work.
- Worker results remain proposals requiring review.

### Warehouse/facility discovery

- A discovery mission can return a company plus structured establishment/facility information.
- The dated commercial trigger and source survive review and acceptance.
- Accepted data can create the relevant company/establishment/signal records without losing provenance.

### Contact

- ChatGPT can list current drafts/validated/scheduled/overdue items.
- ChatGPT can inspect a prospect's sequence.
- If draft write tools are included, they cannot bypass human validation/send policy.

### Skill/routing

- CIRCOE routing guidance identifies VIPER as the primary connector for prospecting/commercial database work.
- The VIPER skill distinguishes interactive assistant behavior from worker behavior.
- The skill never treats itself as an authorization mechanism.

---

## 21. Open decisions to resolve during implementation

These are not blockers to starting all work, but must be resolved before final integration where applicable.

1. Exact relationship between the new user/admin model and delegated interactive agents.
2. Whether agent principals are introduced as a new table or modeled by extending the current token model while preserving stable identity across credential rotation.
3. Exact capability vocabulary. Prefer functional capabilities over only task-type scopes.
4. Whether full mission edits are allowed while a run is active or only queued for future runs.
5. Whether new facility signal kinds are first-class enum values or represented under a generic signal kind with structured subtype.
6. Whether an accepted `find_prospects` item may atomically create company + establishment + signal, or whether review is split into independently selectable items.
7. Whether result accept/reject actions should eventually be exposed to interactive ChatGPT, and under which confirmation/role policy.
8. Whether contact validation/scheduling/sending is ever exposed through ChatGPT or deliberately kept UI-only.
9. Retention policy for rejected/raw agent results, already identified by existing architecture docs as incomplete.
10. How ChatGPT UI resources are packaged and served by VIPER's MCP server while keeping tools independently usable.

---

## 22. Final target architecture

```text
Human user
   |
   v
Interactive ChatGPT
   |  stable agent identity + delegated user + effective capabilities
   v
VIPER MCP conversational API
   |-------------------- read models ---------------------|
   |                                                       |
   +-> companies / prospects / establishments / KPIs      |
   +-> contacts / messages / scheduling state             |
   +-> missions / runs / results                          |
   |                                                       |
   +-> create/update/run Mission                          |
                    |                                      |
                    v                                      |
                Mission scheduler                          |
                    |                                      |
                    v                                      |
                 AgentTask queue                           |
                    |                                      |
          +---------+----------+                           |
          |                    |                           |
          v                    v                           |
      ChatX worker        ChatGPT worker                   |
          |                    |                           |
          +------ claim / research / submit ---------------+
                               |
                               v
                       Reviewable result
                               |
                               v
                         Human decision
                               |
                               v
                         VIPER domain data
```

The strategic principle is simple:

**VIPER remains the source of truth and orchestration layer. ChatGPT becomes a conversational client of VIPER, not a parallel database/orchestrator. Workers execute missions; they do not govern them. Skills guide behavior; the server enforces authority.**
