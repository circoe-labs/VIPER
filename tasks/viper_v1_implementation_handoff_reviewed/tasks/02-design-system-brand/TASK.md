# Task 02 — Implement Neon Command design system and VIPER assets

## Goal
Implement reusable theme tokens, shell primitives and accepted VIPER logo usage for dark/light contrast contexts.

## Context
Neon Command is visual-language authority; accepted geometric Viper/V assets are logo authority. Do not copy security-dashboard content from the board.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Import six accepted logo variants preserving alpha.
- Dark + conservative light theme.
- Color/spacing/radius/border/focus/status tokens.
- Inter typography.
- Base Button/Input/Card/Badge/Table primitives.
- Navigation shell styling and automatic logo-variant switching.

### Out of Scope
- No page-specific business content.
- No new logo direction.
- No heavy glow/animation.

## Dependencies
Task 01.

## Implementation Steps
1. Add assets.
2. Define semantic tokens.
3. Implement theme provider/switch.
4. Build shell/nav/header primitives.
5. Build brand asset helper with mark/lockup contrast rules.
6. Add visual smoke/component examples if tooling supports it.

## Files Likely Touched
Theme CSS/tokens, UI primitives, shell/nav, assets.

## Architecture Constraints
Use semantic tokens rather than scattered hex. Brand green is not a universal success color. Preserve logo alpha.

## Testing Requirements
Contrast/focus checks, theme render smoke, logo file/alpha presence, laptop-width visual smoke.

## Acceptance Criteria
- Neon Command character is recognizable.
- Dark/light coherent.
- All six logo assets usable.
- No moodboard security content leaks into product UI.

## Documentation Updates
Update repo design-system/asset guide.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png` and `../../visuals/viper-*` files.

## Implementation report

Implemented on branch `task-02-design` (worktree `C:\Projects\VIPER-wt-design`), frontend + docs only.

### What was done
- **Assets** — the six accepted logos as web-sized copies in `frontend/src/assets/brand/` (cropped to the artwork,
  2x box-downsampled with premultiplied alpha, ~600 px long side, invisible alpha 1–2 haze cleared, metadata-free
  RGBA PNG): 1.6 MB → ~420 KB. Generated deterministically by `frontend/scripts/optimize-brand-assets.js`
  (`npm run brand:assets`, Node stdlib only). Favicons `frontend/public/favicon-dark.png` (white mark) and
  `favicon-light.png` (black mark), chosen by `prefers-color-scheme`. The moodboard is not copied into the frontend.
- **Tokens** — `frontend/src/theme/tokens.css`: `--nc-*` palette (Neon Command core hexes + derived steps; the only
  raw colours in the codebase) and semantic roles: canvas / surface / surface-raised / surface-hover / field /
  border / border-strong / text / text-muted / accent / accent-hover / on-accent / accent-fg / accent-soft /
  accent-2(-fg) / focus / warning / danger / success (mint, not brand green) / info / neutral / scrim, shadows +
  restrained glow, typography scale, 4 px spacing scale, radii, borders, sizing, z-index, motion (zeroed under
  reduced motion). Dark authored; light derived (off-white canvas, dark slate text, green kept as fill,
  `accent-fg #007A45` for readable green).
- **Typography** — Inter Variable self-hosted via `@fontsource-variable/inter@5.3.0` (pinned).
- **Theme** — `ThemeProvider` + `useTheme` + `ThemeSwitch`; `<html data-theme>`; default dark; explicit choice
  persisted in `localStorage["viper.theme"]` and applied pre-paint by an inline script; OS preference not followed
  (decision I-20).
- **Brand helper** — `BrandLogo variant="mark|lockup|accent"` picks the file from the active theme (`logos.ts`).
- **Primitives** (`frontend/src/ui/`) — Button, IconButton, TextField / TextAreaField / SelectField (label + hint +
  error, aria wiring), Checkbox, Switch, Card, StatusBadge (glyph + text) / Badge, Table (comfortable / compact),
  EmptyState, PageHeader, Modal / Drawer (portal, focus trap, Esc, focus restore, scroll lock, nest-safe) and an
  17-icon geometric line set.
- **Shell** — sidebar with lockup ↔ mark, five sections with icons, active state (accent-soft + accent-fg + neon
  marker), collapsible (persisted, `aria-expanded`), API status as glyph + text, header with reserved search zone
  (Task 17) and theme switch (user menu: Task 04), skip link. Placeholders show only an honest "Bientôt disponible"
  empty state.
- **Dev showcase** — `/_dev/ui` (dev server only, stripped from `dist/`, verified by grepping the build).

### Key files
`frontend/src/theme/{tokens.css,base.css,theme.ts,ThemeProvider.tsx,ThemeSwitch.tsx}`,
`frontend/src/brand/{logos.ts,BrandLogo.tsx}`, `frontend/src/ui/*`, `frontend/src/shell/{AppShell,Sidebar,ApiStatus,PlaceholderPage}.tsx`,
`frontend/src/shell/shell.css`, `frontend/src/lib/storage.ts`, `frontend/src/dev/Showcase.tsx`,
`frontend/scripts/optimize-brand-assets.js`, `frontend/index.html`, `frontend/e2e/design.spec.ts`,
`doc/design/design-system.md`, `doc/design/visual-manifest.md`, `doc/adr/0003-styling-and-theming.md`.

### Tests run (all green)
- `python scripts/check_private_data.py` — OK (129 tracked files).
- `npm run lint`, `npm run typecheck` — clean.
- `npm test` — 10 files, **179 tests** passed: token contrast for both themes, parsed from `tokens.css` (text
  pairs ≥ 4.5:1, focus / field boundary / switch ≥ 3:1), light/dark role parity, no raw colour literal outside
  the token file (122); logo PNG decode — RGBA, transparent outer ring, real artwork (7); BrandLogo variant
  selection (9); theme default / switch / persistence / invalid value / hook guard (4); shell incl. collapse
  persistence and logo switching (9); primitives a11y — Button (4), fields (5), badges / card / table /
  empty state (10), Modal / Drawer focus trap, Esc, focus restore, nested Esc (7); API client (2).
  Mutation-checked: weakening a token and adding a stray hex in a component CSS both fail the suite.
- `npm run build` — OK (showcase absent from `dist/`).
- `npm run e2e` — **7 passed**: existing shell smoke + dark and light at 1440×900 with reload persistence, body
  canvas colour, lockup file per theme, logo corner alpha = 0 read back from a canvas, Inter loaded, collapsed
  sidebar mark, favicons served, no horizontal overflow at 1280 px, showcase + drawer screenshots for both themes
  (`frontend/test-results/screenshots/`, git-ignored). The screenshots were reviewed against the moodboard;
  fixes made after review: bigger lockup, active marker moved onto the item, header rule removed, overlay
  screenshots taken with animations disabled.

### Deviations / decisions
- I-20 (dark by default, OS preference only for the favicon), I-21 (derived logo copies; logo lime `#79FA03` vs UI
  Viper Green `#00E676` kept as delivered), I-22 (mint success tone; dev showcase route) — decision log.
- ADR-0003: plain co-located CSS + custom properties, attribute theming, tests parse the real CSS.
- `tsconfig.node.json` gains the `DOM` lib (Playwright `evaluate` callbacks); `vite.config.ts` lets Vitest process
  `?raw` CSS imports only.
- `@fontsource-variable/inter` added (pinned, OFL-1.1).

### Open points
- The sidebar lockup is the stacked (mark over wordmark) artwork; a horizontal lockup would suit a sidebar better
  but would be a new logo asset (out of scope).
- Logo neon (lime) and UI accent (Viper Green) differ; converging them is a brand decision for the product owner.
- Light theme is a conservative derivation ("pixel-perfect light theme" remains deferred in the decision log).
