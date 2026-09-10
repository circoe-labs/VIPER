# Design System — Neon Command

## Authoritative visual reference
`../../tasks/viper_v1_implementation_handoff_reviewed/visuals/neon-command-brand-direction.png`

**Important:** this board is authoritative for visual language only — palette, contrast, surfaces, spacing, typography, line-icon style and restrained glow. Its cyber-security copy, threat metrics, world map and illustrated snake logo are **not VIPER product requirements** and must not be reproduced.

The actual product identity is the accepted geometric V/viper logo family — see [`visual-manifest.md`](visual-manifest.md).

## Brand character
Modern AI/tech, premium, controlled, spacious, dark-first. Clean rather than gamer-like. Neon is a signal, not wallpaper.

## Implementation map (Task 02)

Styling approach and rationale: [ADR-0003](../adr/0003-styling-and-theming.md).

| What | Where (`frontend/`) |
|---|---|
| Tokens (only file with raw colour values) | `src/theme/tokens.css` |
| Element defaults, focus ring, `.visually-hidden`, `.eyebrow` | `src/theme/base.css` |
| Theme state / hook / switch | `src/theme/ThemeProvider.tsx`, `src/theme/theme.ts` (`useTheme`), `src/theme/ThemeSwitch.tsx` |
| Logo helper | `src/brand/BrandLogo.tsx`, selection rule in `src/brand/logos.ts` |
| Primitives + icons | `src/ui/*` (each component imports its own CSS file) |
| App shell | `src/shell/AppShell.tsx`, `Sidebar.tsx`, `ApiStatus.tsx`, `shell.css` |
| Component showcase (dev server only) | `/_dev/ui` → `src/dev/Showcase.tsx`; excluded from production builds |
| Font | `@fontsource-variable/inter` (self-hosted Inter Variable, imported in `src/main.tsx`; no CDN) |

## Tokens

Two layers in `tokens.css`:

1. **Palette** `--nc-*` — the raw hexes: the seven Neon Command core colours plus derived steps. Nothing outside
   `tokens.css` may use a hex/`rgb()`/`hsl()` literal (enforced by `src/theme/tokens.test.ts`).
2. **Semantic roles** — what components use. Never reference `--nc-*` from a component.

### Core palette (from the board, unchanged)

| Token | Hex | Use |
|---|---|---|
| `--nc-void` | `#0A0B0D` | deepest app canvas |
| `--nc-charcoal` | `#1B2329` | raised panels / hover |
| `--nc-slate` | `#2E3A40` | borders / muted UI |
| `--nc-viper-green` | `#00E676` | primary accent / focus / active brand moments |
| `--nc-teal` | `#00C2B8` | secondary accent / data highlights |
| `--nc-ice` | `#EAF2F1` | primary dark-theme text / icons |
| `--nc-deep-emerald` | `#10261F` | tinted surfaces (active nav, accent-soft) |

### Semantic colour roles

| Role | Dark (authored) | Light (derived) | Use |
|---|---|---|---|
| `--color-canvas` | void `#0A0B0D` | paper `#F4F7F7` | page background |
| `--color-surface` | graphite `#11171B` | white | sidebar, cards, tables |
| `--color-surface-raised` | charcoal `#1B2329` | white (+ shadow) | drawers, modals, secondary buttons |
| `--color-surface-hover` | charcoal `#1B2329` | ice `#EAF2F1` | hover rows / nav items |
| `--color-field` | void | white | input backgrounds |
| `--color-border` | slate `#2E3A40` | `#D5DEE0` | decorative dividers, card borders |
| `--color-border-strong` | `#56676E` | `#7C8C92` | form-field boundaries (≥ 3:1) |
| `--color-text` | ice | ink `#0F1A1F` | body text |
| `--color-text-muted` | mist `#9AA8AD` | `#4E5E65` | secondary text, inactive nav |
| `--color-accent` | viper green | viper green | **fills only** (primary button, checked box, active bar) |
| `--color-accent-hover` | `#4DF09F` | `#00CF6A` | primary button hover |
| `--color-on-accent` | void | void | text/icons on accent fills |
| `--color-accent-fg` | viper green | `#007A45` | accent-coloured text/icons (active nav, links) |
| `--color-accent-soft` | deep emerald | `#E3F6EC` | tinted backgrounds (active nav, empty-state icon) |
| `--color-accent-2` / `-2-fg` | teal / teal | teal / `#00756F` | secondary highlight fill / text |
| `--color-focus` | viper green | `#007A45` | focus ring |
| `--color-warning-fg` / `-soft` | `#FFB547` / `#241C0E` | `#8A5A00` / `#FFF4DC` | verification needed, stale (yellow/orange) |
| `--color-danger` / `--color-on-danger` | `#F0564F` / void | `#C0362C` / white | destructive button fill / its text |
| `--color-danger-fg` / `-soft` | `#FF7A7A` / `#2A1416` | `#B42318` / `#FDECEA` | errors, do-not-contact |
| `--color-success-fg` / `-soft` | mint `#7FD1AE` / `#0E231B` | `#1D6E4B` / `#E6F5EE` | verified / positive — deliberately **not** brand green |
| `--color-info-fg` / `-soft` | `#6CB6FF` / `#0F1D2B` | `#1F5FAD` / `#E8F1FC` | neutral information |
| `--color-neutral-fg` / `-soft` | `#C3CED1` / `#232D33` | `#3E4D54` / `#E9EEEF` | unknown / inactive / plain tags |
| `--color-scrim` | void 72 % | ink 40 % | modal/drawer backdrop |
| `--shadow-sm`, `--shadow-overlay`, `--shadow-glow` | — | — | card lift, overlays, the restrained neon glow (primary hover, active nav bar) |

Contrast is asserted by `src/theme/tokens.test.ts`, which parses `tokens.css` itself and resolves `var()` chains
for both themes: every text pair (text / text-muted / accent-fg / danger-fg on every surface, badge fg on its soft
background, on-accent on accent, on-danger on danger…) ≥ **4.5:1**; focus ring on every surface, field boundary and
switch thumb ≥ **3:1**. The test also requires the light block to redefine every dark colour role.

**Why `accent` vs `accent-fg`:** Viper Green on white is only 1.6:1. In the light theme the green stays the brand
fill (buttons with void text are 11.8:1) while text and icons use `--color-accent-fg`. Use `accent` only as a
background/fill, `accent-fg` for anything that must be read.

### Non-colour tokens

| Group | Tokens |
|---|---|
| Typography | `--font-sans` (Inter Variable → system fallback), `--font-mono`; sizes `--text-xs` 12 · `sm` 13 · `md` 14 (body) · `lg` 16 · `xl` 20 · `2xl` 26 (page h1) · `3xl` 32 px; `--leading-tight` 1.25 / `--leading-normal` 1.5; `--weight-regular/medium/semibold/bold`; `--tracking-tight` (headings), `--tracking-label` (uppercase micro-labels) |
| Spacing (4 px base) | `--space-0 1 2 3 4 5 6 8 10 12 16` = 0 · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 px; `--page-padding` = 40 px |
| Shape | `--radius-sm` 6 (controls, badges) · `md` 10 (cards, tables) · `lg` 14 (modals, empty states) · `full` (switch/dots only); `--border-width` 1 px; `--focus-ring-width` / `-offset` 2 px |
| Sizing | `--control-sm` 32 px, `--control-md` 40 px; `--sidebar-width` 256 px / `--sidebar-width-collapsed` 72 px; `--header-height` 64 px |
| Layers | `--z-sticky` 10 (table headers) · `--z-sidebar` 20 · `--z-header` 30 · `--z-overlay` 100 (modal/drawer/skip link) |
| Motion | `--duration-fast` 120 ms, `--duration-base` 200 ms, `--ease-standard`; both become 0 under `prefers-reduced-motion` |

## Theme behaviour

- Dark is the primary authored theme and the **default**. Light is a conservative semantic derivation (off-white
  canvas, white surfaces, dark slate text, same green/teal accents at accessible contrast). No second identity.
- The theme lives on `<html data-theme="dark|light">`; `tokens.css` keys off it (`:root` alone = dark).
- `ThemeSwitch` (header, right) toggles it. An **explicit choice** is stored in `localStorage["viper.theme"]` and
  restored on the next visit; an inline script in `index.html` applies it before first paint (no flash).
- Without a stored choice the app is dark regardless of the OS `prefers-color-scheme` (decision I-20). The OS
  preference only drives the favicon, because the browser tab strip follows the OS, not the app.
- The sidebar collapsed state is remembered the same way (`localStorage["viper.sidebar"]`). Storage failures
  (private mode) fall back to in-memory state (`src/lib/storage.ts`).

## Typography
Inter Variable, self-hosted. Body 14 px / 1.5; page titles 26 px semibold with slight negative tracking.
All-caps only through `.eyebrow` / table headers (12 px, 0.08 em tracking). Tabular figures for numeric columns
(`.table__numeric`).

## Density/shape
Generous page padding (40 px), medium radii, thin slate borders, minimal shadows, no pill-everything, restrained glow
(only the primary-button hover and the active-nav marker glow). `Table density="compact"` is for the Database
explorer; Prospection lists stay `comfortable` and people-oriented.

## Icon style
Minimal geometric line icons (`src/ui/icons.tsx`): 24 px grid, 1.75 stroke, round caps/joins, `currentColor`,
`aria-hidden` (the accessible name always comes from text or the control label). Geometric shapes only — no snakes.
Set: navigation (`Home`, `Users`, `Bolt`, `Database`, `Sliders`), status (`CheckCircle`, `Alert`, `Ban`, `Info`,
`Clock`, `MinusCircle`), interface (`Sun`, `Moon`, `PanelLeft`, `Close`, `Plus`, `Spinner`), data/explorer (`Search`,
`Refresh`, `Download`, `Filter`, `Key`, `Link`, `ArrowUp/Down/Left`, `ChevronLeft/Right`, `Columns`, `Pin`, `More`,
`Copy`, `Expand`, `Table`). Add icons in the same file and style.

## Primitives catalogue (`src/ui/`)

| Component | API essentials | Rules |
|---|---|---|
| `Button` | `variant` primary \| secondary (default) \| ghost \| danger, `size` sm \| md, `icon`, `loading` | `type="button"` unless `type="submit"` is passed. `loading` disables + `aria-busy`. One primary per view area. |
| `IconButton` | `icon`, `label` (required → `aria-label` + tooltip), `variant` ghost \| secondary, `size` | Never icon-only without `label`. |
| `TextField` / `TextAreaField` / `SelectField` | `label` (required), `hint`, `error`, native props | Label bound via id; hint + error linked by `aria-describedby`; `error` sets `aria-invalid` and shows icon + text. `required` adds a visual `*`. |
| `Checkbox` / `Switch` | `label`, `hint`, native checkbox props | `Switch` has `role="switch"` and is for settings applied immediately; form values use `Checkbox`. |
| `Card` | `title?`, `actions?` | With a title it is a named `region` (`<section>` + `<h2>`). |
| `StatusBadge` | `tone` success \| warning \| danger \| info \| neutral, `icon?`, text children | Always glyph + text (never colour alone). success = verified/positive (mint, not brand green), warning = unverified/stale, danger = do-not-contact/destructive, neutral = unknown/inactive. |
| `Badge` | `tone` neutral \| accent | Plain tags/counts, no status meaning. |
| `Table` | `caption` (required), `density` comfortable \| compact; children `<thead>/<tbody>` | Focusable named scroll region, sticky header, `.table__numeric` for numbers/dates. |
| `EmptyState` | `icon`, `title`, `description?`, `action?` | Honest absence of data + next action. |
| `PageHeader` | `title` (the page `<h1>`), `description?`, `actions?` | One per routed page. |
| `Modal` / `Drawer` | `open`, `onClose`, `title`, `description?`, `footer?`, `initialFocusRef?`, `size` (modal sm/md/lg, drawer md/lg/xl) | Portal, `role="dialog"` + `aria-modal` + labelled/described; focus moves in (dialog or `initialFocusRef`), Tab/Shift+Tab trapped, Esc / backdrop / close button call `onClose`, focus restored to the trigger, body scroll locked. Nested dialogs close one at a time. Guard unsaved changes inside `onClose`. Drawer = editors that keep the list in context (Prospect, Company). |
| `Menu` | `label`, `position` (viewport point), `alignRight?`, `sections` (`label?`, `items`: `id`, `label`, `icon?`, `hint?`, `disabled?`, `onSelect`), `onClose` | Context/action menu (WAI-ARIA menu): portal, first item focused, ↑/↓/Home/End skip disabled items and wrap, Enter/Space select (menu closes first, then the action runs), Esc/Tab/outside press close; focus returns to the trigger; clamped inside the viewport. Mounted only while open. |
| `Popover` | `anchor`, `label`, `onClose`, `alignRight?` | Small **non-modal** dialog under a control (filter editor, column chooser): first field focused, Esc/outside press close, focus restored, Tab not trapped. |

## Database explorer grid
Denser than Prospection but legible: 13 px data on 36 px rows, 56 px two-line headers (name + SQL type), subtle
zebra and grid lines derived with `color-mix()` from surface/border tokens, row numbers and pinned columns on the
header tint with a stronger edge after the last pinned column, active cell outlined with the focus colour, FK values
in `--color-accent-2-fg` (teal), NULL as small italic muted `NULL`. The explorer page fills the viewport so the grid,
not the page, scrolls; toolbar labels collapse to icons through a container query when the workspace is narrow.
Styles: `frontend/src/database/database.css` (feature doc: `doc/features/database-explorer.md`).

## App shell
Left sidebar: lockup (expanded) or mark (collapsed), the five sections with icons, active item = accent-soft
background + accent-fg text + neon left marker (`aria-current="page"`); footer = API status (glyph + text) and the
collapse toggle (`aria-expanded`/`aria-controls`). Collapsed labels stay in the accessible name and as tooltips.
Header: left zone reserved for global search (Task 17), right zone = theme switch, then the authenticated user
(Task 04). Skip link "Aller au contenu". Desktop-first; verified at 1280–1920 px (no horizontal overflow at 1280).

## VIPER logo usage
Always through `BrandLogo` (`variant` + `height`, `decorative` when adjacent text already says VIPER); it picks the
file from the active theme:

| `variant` | Dark theme | Light theme | Context |
|---|---|---|---|
| `mark` | `viper-mark-white` | `viper-mark-black` | collapsed sidebar, small icon contexts |
| `lockup` | `viper-lockup-white` | `viper-lockup-black` | expanded sidebar, login, about |
| `accent` | `viper-mark-neon-green-black` | `viper-mark-black-neon-green` | hero / premium accents only — never everyday navigation |

Favicons (static, `public/`): `favicon-dark.png` (white mark) for dark browser chrome, `favicon-light.png` (black
mark) for light chrome, selected with `media="(prefers-color-scheme: …)"`. Preserve alpha; never bake a rectangle
behind the assets (enforced by `src/brand/assets.test.ts` and the Playwright canvas check). File locations and
derivation: [`visual-manifest.md`](visual-manifest.md).
