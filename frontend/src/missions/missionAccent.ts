
// Mission UI hues (Slice 01 contract, tasks/viper_mission_ui_redesign/01-ui-contract/CONTRACT.md §2.3).
// (The per-mission hashed accent is gone: a mission takes its category's colour, see categoryVisual.ts.)
// An accent is DECORATION that tells two missions apart at a glance; it never encodes a status, a type or a
// priority. Meaning always comes from text + glyph (StatusBadge, labels). Colours live in tokens.css and are mapped
// to `--mui-fg` / `--mui-soft` by `[data-hue]` in missionUi.css.

export const MISSION_ACCENTS = ['green', 'blue', 'amber', 'purple', 'teal', 'indigo'] as const
export type MissionAccent = (typeof MISSION_ACCENTS)[number]

// Hues usable on a chart segment or a KPI tile: the six accents plus the semantic ones.
export type MissionHue = MissionAccent | 'success' | 'danger' | 'neutral'
