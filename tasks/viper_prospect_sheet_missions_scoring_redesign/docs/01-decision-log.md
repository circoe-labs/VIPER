# Decision log

## Locked
1. Keep **Profil / Suivi** tabs.
2. Visual reference is directional, not pixel-contractual.
3. Top hierarchy: prospect fit score + fiche completeness state + proximity score, then summary/contact essentials.
4. `prospect_score` = commercial fit only.
5. Relationship graph is excluded from prospect fit and represented by `proximity_score`.
6. Data quality becomes a named state, not a displayed 0–100 score.
7. Mission action is a compact menu, not a full-screen overlay.
8. Presets: Complete fiche / Reanalyse score / Cherche relations / Autre.
9. Custom mission supports microphone input by reusing the existing speech-input path where practical.
10. Rescoring uses mission/agent infrastructure and yields explainable, traceable evidence.
11. Right-click action cannot be the only path to Contact; keyboard/button parity is required.

## Repository evidence that must be reused
- `frontend/src/prospects/ProspectEditor.tsx`: existing Profil/Suivi tabs and drawer editor.
- `frontend/src/prospects/ProspectScoreCard.tsx`: current explainable score UI.
- `backend/app/services/prospect_score.py`: current score contract/service.
- `backend/app/services/prospect_data_quality.py`: current numeric data-quality service.
- `frontend/src/prospects/ProspectLinksCard.tsx` + `backend/app/services/person_links.py`: relationship graph.
- Mission APIs/services already support prospect targets and existing voice-input utilities exist under `frontend/src/missions/voice/`.

## Coordination decision
There is an existing queued handoff `viper_prospect_intelligence_graph_scoring_followups` that explicitly includes path-based reachability scoring. Slice 03 must inspect its status and reuse/supersede the relevant contract rather than ship a competing proximity algorithm.
