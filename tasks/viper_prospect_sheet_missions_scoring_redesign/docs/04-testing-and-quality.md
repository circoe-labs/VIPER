# Testing and quality

## Per-Slice
Do not launch the complete unit test suite at a Slice boundary. Use:
- code review;
- TypeScript/Python type/static checks scoped as appropriate;
- targeted component/service checks;
- bounded runtime smoke checks;
- agent trace evidence for mission/AI flows;
- accessibility checks for context menu, dropdown, keyboard navigation, dialogs/popovers.

## Final convergence — Slice 07 only
Run the complete backend/frontend unit suites once, plus integration and Playwright/E2E in the same final phase (parallel only when resource isolation is safe). Validate:
- desktop and narrow widths;
- Profil and Suivi;
- save/navigation behavior unchanged;
- score cards/states load, refresh and error states;
- mission menu presets and custom microphone path;
- mission target is the current prospect;
- rescore result is explainable/traceable;
- proximity score excludes commercial-fit score;
- contact context action has accessible parity.

Regressions introduced by this task block acceptance and are not parked as Issues.
