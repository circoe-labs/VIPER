# VIPER — Refonte UX Accueil / Prospection / Contact
Drive source: folder 1-Wg8sLZxy0Or0NcLceY9Gc-4prOi0ZTv (VIPER/task/to-do). Unpacked locally (origin: remote). Faithful condensed copy; Drive is authoritative.

## Mission
Separate: **Accueil** (synthetic pilotage + navigation), **Prospection** (DB state/progress), **Contact** (commercial follow-up: to contact, contacted, follow-ups, replies, appointments, errors, next waves).
Simplify navigation, remove useless blocks/sub-categories, keep tables directly visible, make indicators actionable via deep-link to filtered view.

## Locked constraints
- Do NOT use assistant-generated visuals from the discussion as UI reference.
- Reuse design system, components, routes, read models, patterns.
- Prospects/Entreprises/Entrepôts selector drives Prospection main content; no hidden sub-nav/mandatory accordion.
- Every important counter clickable -> filtered view. Show weekly "+" for new prospects/companies/warehouses and sub-statuses when relevant.
- Never invent a delta/stat/status the backend cannot honestly produce.
- IProspect / VIPER / IContact responsibilities stay separate.
- Neighbor handoff to coordinate, not duplicate: viper_mission_ui_redesign_source_truth.

## Repo evidence
frontend/src/prospection/ProspectionPage.tsx (mixes overview/validation/companies/search/follow-up behind details); frontend/src/contact/ContactPage.tsx (focused on already-contacted); frontend/src/home/HomePage.tsx (clickable cards, some wrong destinations); frontend/src/{companies,prospects,warehouses}; frontend/src/routes.tsx (keep bookmarks working).

## Execution model
Slice 00 = PM readiness gate (READY / CONTEXT_REWORK_REQUIRED / CONFLICT / HUMAN_DECISION_REQUIRED). Then 01,02,03,04 parallel if no file collision. 05 = routes/deep-links convergence (after 02+03+04). 06 = only full unit+integration+E2E campaign (after 01..05).
QA: implementation slices = review + targeted type/build/static + bounded smoke only; no full unit suite.
Coding slices: /caveman + /coding-guideline; frontend: /impeccable.
Slices: 00 project-manager, 01 metrics-read-model, 02 prospection-base-ux, 03 contact-commercial-ux, 04 home-pilotage-ux, 05 navigation-deeplinks, 06 integration-e2e.
