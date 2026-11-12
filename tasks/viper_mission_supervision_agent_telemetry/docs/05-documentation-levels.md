# Documentation levels

| Concept | Current level | Required level | Action |
|---|---:|---:|---|
| Mission / Run / Task / Result | 2-3 | 3 | Preserve canonical docs and implementation contracts. |
| Agent claim / lease / heartbeat | 3 | 3 | Reuse; document session interaction. |
| Mission agent session | 0 | 2 then 3 | Slice 01 contract, Slice 03 implementation. |
| Mission agent log | 0 | 2 then 3 | Slice 01 contract, Slice 03/04 implementation. |
| Per-item confidence/source freshness | 1 | 3 | Slice 02 schema + normalized proposal contract. |
| Mission supervision read APIs | 0 | 3 | Slice 05. |
| Mission tab information architecture | 0-1 | 3 | Slices 06-09 + tests. |
| Factual research-report policy | 0 | 2-3 | Slice 01 docs, Slice 04 payload/tool guidance. |

No implementation should invent behavior where a Level-2 contract is still unresolved.
