# VIPER — Documentation

Living documentation for **VIPER** (*Validation Interface for Prospecting, Execution & Revenue*).
This folder is the durable home of product intentions, technical decisions and working rules. It must stay
true for the whole life of the project: whenever code changes a behaviour, a rule or a decision, the matching
page here changes in the same commit.

## Source of truth hierarchy

1. **Human decisions** — `product/decision-log.md` (locked grill decisions + later orchestrator/product decisions).
2. **Architecture Decision Records** — `adr/` (one file per significant technical choice, never rewritten; superseded by a new ADR).
3. **Specifications** — `architecture/`, `features/`, `design/` (kept in sync with the implementation).
4. **Original handoff snapshot** — `../tasks/viper_v1_implementation_handoff_reviewed/` (frozen reference of the
   reviewed handoff; only its `tasks/TODO.md` status and per-task reports are updated).

When the handoff and this folder disagree, this folder wins **only if** the change is recorded in the decision log
or an ADR with its rationale.

## Map

| Folder | Content |
|---|---|
| `product/` | Vision & scope, decision log, open questions |
| `architecture/` | Layers/boundaries, data model, security & privacy |
| `features/` | Interface spec, Excel import/export contract, feature-level behaviour (KPIs, filters, SQL limits…) |
| `design/` | Neon Command design system, logo/asset usage |
| `adr/` | Architecture Decision Records (`NNNN-title.md`) |
| `process/` | Agent brief, orchestration log, testing strategy, runbooks |
| `legacy/` | Non-PII profile of the historical Excel workbook |

## Privacy rule (non-negotiable)

The GitHub repository is **public**. No real contact data (names, emails, phones, rows, screenshots of rows)
may ever appear in this folder, in code, in fixtures, in logs or in CI. See `architecture/security-and-privacy.md`.
