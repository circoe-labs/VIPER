# Testing and quality

## Per-slice policy
Implementation slices do not run the complete unit test suite by default. Per-slice QA consists of:
- code review;
- TypeScript/type/static/build checks where warranted;
- focused component/runtime smoke checks;
- accessibility inspection for changed controls/charts;
- targeted individual tests only when diagnosing a specific defect.

Do not infer a broad unit-test campaign from an `Automated Validation` section.

## Final convergence
Slice 05 owns the complete validation phase:
- frontend and backend unit suites relevant to the repository;
- integration checks for mission read models and review actions;
- E2E for list -> mission -> statistics -> result review;
- visual regression/reference comparison at target desktop widths and responsive checks;
- keyboard/focus/accessibility checks;
- zero/loading/error/partial-data states.

Run unit and E2E suites concurrently when isolation/resources allow; otherwise run them in the same final validation phase. Failures introduced by this task are blocking and returned to the responsible slice for correction.

## Visual QA
Acceptance is not “components exist”. Compare information hierarchy, density, grouping, chart composition, interaction placement and responsive behavior against the supplied reference screens. Preserve VIPER semantics when a pixel-perfect element conflicts with actual product state or accessibility.
