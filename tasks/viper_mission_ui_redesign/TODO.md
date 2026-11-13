# VIPER Mission UI redesign — graph execution view

Numbering is not a serial execution mandate.

- [ ] **00** `00-project-manager` — blind readiness audit, overlap reconciliation, dispatch plan.
- [ ] **01** `01-ui-contract` — map the supplied three screens to current VIPER behavior and establish shared UI contract/primitives.
- [ ] **02** `02-missions-list` — redesign the general Missions surface.
- [ ] **03** `03-mission-statistics` — redesign mission-specific statistics and charts.
- [ ] **04** `04-mission-detail-review` — redesign Mission detail/result-review surface.
- [ ] **05** `05-integration-e2e` — final integration, accessibility, visual QA and full test phase.

## Hard dependencies
- 00 gates all dispatch.
- 01 depends on 00.
- 02, 03 and 04 depend on 01.
- 05 depends on 02 + 03 + 04.

## Initial ready set
After Slice 00: **01**.
After Slice 01: **02 + 03 + 04** concurrently when file ownership is parallel-safe.

## Main unlocks
- 01 publishes the visual/component contract and unlocks the three product surfaces.
- Completion of 02/03/04 unlocks final convergence 05.
