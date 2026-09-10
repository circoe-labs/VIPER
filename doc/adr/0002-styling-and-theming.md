# ADR-0002 — Styling and theming: plain CSS with semantic custom properties

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 02 (design system), reviewed by the orchestrator
- Related: [ADR-0001](0001-stack.md) (no UI kit / no Tailwind), `doc/design/design-system.md`,
  `doc/product/decision-log.md` (I-09, I-10)

## Context

ADR-0001 fixed "hand-written CSS, no UI kit, no Tailwind" and deferred the token design to Task 02. Every later UI
task (Prospection, editors, Database explorer…) will build on whatever convention Task 02 sets, so it needs to be
explicit: how styles are scoped, where colours may live, how dark/light switch, and how contrast is guaranteed.
Constraints: two themes with the same identity, WCAG AA contrast, no scattered hex values, no new heavy dependency,
Vite 8 + React 19, tests in Vitest/jsdom.

## Decision

1. **Plain global CSS files co-located with components** (`Button.tsx` imports `button.css`), BEM-like class
   names (`.btn`, `.btn--primary`, `.field__label`, `.sidebar__nav`). No CSS Modules, no CSS-in-JS, no preprocessor.
   Vite bundles them into one stylesheet.
2. **CSS custom properties are the single source of truth for design values**, in one file,
   `src/theme/tokens.css`, with two layers: `--nc-*` palette (the only place raw colours may appear) and semantic
   roles (`--color-surface`, `--color-accent-fg`, `--space-6`, `--radius-md`, …) that components consume. Derived
   colours in components are limited to `color-mix()` of semantic tokens (e.g. badge borders).
3. **Theme switching by attribute**: `<html data-theme="dark|light">`; bare `:root` carries the dark roles, and
   `:root[data-theme='light']` redefines every colour role. A React `ThemeProvider` owns the state and persists the
   explicit choice in `localStorage`; a tiny inline script in `index.html` applies it before first paint.
4. **Tests read the real CSS**: `tokens.test.ts` imports `tokens.css?raw` (Vitest is configured to process only
   `?raw` CSS imports), resolves `var()` chains per theme, and asserts WCAG ratios; the same suite scans every
   `src/**/*.{css,ts,tsx}` file (except tokens and tests) and fails on any hex/`rgb()`/`hsl()`-style literal.
5. **Inter** is self-hosted through `@fontsource-variable/inter` (OFL-1.1, pinned); no font CDN.

## Consequences

- Zero runtime cost and no new build tooling; any developer can read the styles. Themes switch instantly with no
  React re-render of styled components.
- Global class names can collide: new components must use a unique block prefix (component name) and never style
  bare elements outside `base.css`. Reviewers should reject un-prefixed selectors.
- Contrast and "no scattered colours" are regression-tested, so a token tweak that breaks AA fails CI.
- The token values are not importable as TypeScript constants; code needing a value at runtime reads the custom
  property (`getComputedStyle`) instead of duplicating it.
- Adding a colour role means adding it to both theme blocks (the test enforces parity) and, when it carries text,
  adding its pair to the contrast table.

## Alternatives considered

- **CSS Modules** — local scoping for free, but every component then needs class-name plumbing for variants, and
  shared layout classes (`.visually-hidden`, `.eyebrow`, table helpers) become awkward; the project is small enough
  for a naming convention.
- **CSS-in-JS (vanilla-extract, styled-components)** — typed tokens, but adds a dependency and a build plugin (or a
  runtime) against the "don't add dependencies casually" rule, for little benefit over custom properties.
- **Tokens in a TS/JSON file generating CSS** — makes tokens importable in TS, but needs a generation step or runtime
  injection (flash of unstyled content); parsing the CSS in the test gives the same guarantee with one source.
- **Follow `prefers-color-scheme` by default** — rejected for the in-app theme (decision I-09): dark is the authored
  identity; the OS preference is used only for the favicon.
