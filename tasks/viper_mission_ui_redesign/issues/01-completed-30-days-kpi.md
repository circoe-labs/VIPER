# « Terminées (30 jours) » tile counts all-time done missions

Reference screen 1 shows « Terminées (30 jours) ». `MissionCard` has no completion date, so the tile reads « Terminées » (all time), CONTRACT §6 D1. Follow-up: add `completed_at` to the card read model (backend + `api/missions.ts`), then filter to 30 days in `missionCounters` and relabel. Same decision family: D2 (`agents_count` instead of the configured agent label on the card).
