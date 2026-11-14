# Implementation strategy (copy of Drive docs/03)
Graph: 00 -> {01,02,03,04} ; 02+03+04 -> 05 ; 01..05 -> 06.
Soft: 02/03/04 need 01 for live data (start with fixtures/interfaces); 04 needs final filtered routes of 02/03 (provisional descriptors ok).
Hot files: routes.tsx reserved to 05; shared API types owned by 01 (others use adapters/fixtures); no design-token/shared-UI changes unless proven necessary.
Checkpoints: before closing 02/03/04 reconcile fixtures with 01 read model; before 05 freeze query params/destinations; before 06 no simulated counter remains.
