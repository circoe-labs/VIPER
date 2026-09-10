# VIPER V1 — Task Orchestration (reviewed)

## Project context
VIPER V1 is a database-first human dashboard for maintaining prospect/company/contact data and lightweight contact/appointment tracking. Manual work is the V1 reality. The database must nevertheless remain future-agent ready.

## Mandatory execution rules
- Start at Task 00 and stay in orchestration mode.
- For every coding task, load `/caveman` and `/coding-guideline` from `~/ai/skills/` before editing.
- Complete/test/document one task before moving to the next.
- Update this TODO and TASK files if repo reality changes dependencies.
- **Never commit or log `sources/BASE_CLIENT.xlsx` or real contact rows; target repo was public. Use synthetic committed fixtures.**
- No fake IProspect/IContact/email/Calendly behavior.
- Do not turn VIPER into a rich CRM.
- Neon Command is visual-language reference only; actual logo is the geometric Viper/V asset family.

## Status
`[ ]` not started · `[~]` in progress · `[x]` complete · `[-]` explicitly deferred with rationale

## Ordered tasks
- [x] **00** `00-orchestrator` — repo/source safety + plan control
- [x] **01** `01-foundation-stack` — choose stack, scaffold, CI, private-data guardrails
- [x] **02** `02-design-system-brand` — Neon Command + all accepted VIPER assets/themes
- [x] **03** `03-data-schema` — reviewed relational model + migrations
- [x] **04** `04-authentication-actor` — secure single-user auth + actor context
- [x] **05** `05-audit-provenance-core` — audit/provenance foundation before feature mutations
- [x] **06** `06-settings-taxonomies` — roles/categories/segments/referents
- [x] **07** `07-company-editor` — lightweight company/establishment maintenance
- [x] **08** `08-excel-import-core` — deterministic parser/mapping/diagnostics
- [x] **09** `09-excel-import-review` — preview/correction/dedup/transactional commit
- [~] **10** `10-excel-export` — normalized configurable Excel export
- [x] **11** `11-database-explorer-read` — tables/metadata/grid/read ergonomics
- [x] **12** `12-database-explorer-edit` — staged edit/delete/audit
- [x] **13** `13-database-explorer-sql` — backend-enforced read-only SQL
- [~] **14** `14-prospection-workspace` — actionable counters/filters/people list
- [ ] **15** `15-prospect-editor` — create/edit/verification/contact aliases/Save & Next
- [ ] **16** `16-home-dashboard` — global activity/database-health dashboard
- [ ] **17** `17-global-search` — cross-entity quick search (explicitly defer only if necessary)
- [x] **18** `18-exploitation-placeholder` — Coming soon only
- [ ] **19** `19-audit-history-ui` — focused visible history/provenance
- [ ] **20** `20-hardening` — E2E/security/privacy/perf/accessibility/final report

## Global acceptance gates
1. Secure authenticated app boots from fresh clone and migrations run.
2. Real legacy workbook can be privately parsed/import-previewed without PII leakage.
3. Import supports correction/exclusion/dedup and never silently loses unknown data.
4. Manual company/prospect updates persist and are audited/provenanced.
5. Permanent do-not-contact state survives re-import and is distinct from non-interest.
6. Export reflects normalized edits and never recreates Referent/verification conflation.
7. Prospection is efficient: counters→filters, readable people list, prefilled editor, Save & Next.
8. Database Explorer is genuinely useful and safe: read ergonomics, staged writes, read-only SQL.
9. Home shows real global/manual activity including response/no-response/appointment states and next actions.
10. Exploitation contains no fake functionality.
11. Neon Command styling and accepted VIPER assets are used correctly in dark/light contexts.
12. Tests/CI green; public repo contains no private source workbook/raw contact data.

## Picking the next task
Choose the first unchecked task whose dependencies are complete. Do not skip ahead because a later UI task looks more visible. If a dependency is no longer necessary, edit the affected task docs before proceeding.

## Reporting
Record tests and deviations at the end of each task. Task 20 must use the final implementation report template.

## Execution notes (repo reality)
- Living documentation lives in `/doc` (see `doc/README.md`); orchestration history in `doc/process/orchestration-log.md`.
- `/caveman` and `/coding-guideline` skills are not installed; `doc/process/agent-brief.md` replaces them (decision I-05).
