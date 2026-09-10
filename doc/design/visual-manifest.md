# Visual Manifest

Originals live in the frozen handoff folder `tasks/viper_v1_implementation_handoff_reviewed/visuals/` (committed,
never edited). The app uses web-sized copies generated from them by `frontend/scripts/optimize-brand-assets.js`
(`npm run brand:assets` from `frontend/`, Node standard library only, deterministic):

- crop to the artwork's alpha bounding box + 2 % transparent margin;
- 2× box downsample with premultiplied alpha (≈ 600 px on the long side, enough for a 300 px hero at 2× DPR);
- alpha 1–2 "haze" left by the source export cleared to 0 so the background is truly empty;
- re-encoded as 8-bit RGBA PNG without ancillary chunks (the originals' ~22 KB C2PA `caBX` metadata is not carried
  into the web copies; the originals keep it).

Sizes: 1.6 MB of originals → ≈ 420 KB for the six copies; the shell only loads the one variant it shows.
`src/brand/assets.test.ts` decodes every committed copy and asserts RGBA, a fully transparent outer ring and real
artwork; Playwright re-checks the rendered sidebar logo's corner alpha in both themes.

Selection in code: `frontend/src/brand/logos.ts` + `BrandLogo` (rule table in `design-system.md`).

## neon-command-brand-direction.png
- Location: `tasks/viper_v1_implementation_handoff_reviewed/visuals/neon-command-brand-direction.png` (not copied
  into the frontend)
- Scope: global visual reference
- Source decision: user selected Neon Command as VIPER's base art direction
- Status: global-reference
- Used by: shell/design-system and all UI tasks
- Important: visual language only; cyber-security content and snake illustration are not product requirements

## viper-mark-black.png
- Original: `visuals/viper-mark-black.png` · App copy: `frontend/src/assets/brand/viper-mark-black.png`
- Scope: global brand asset
- Status: selected/final-family
- Use: mark-only on light backgrounds — `BrandLogo variant="mark"` in the light theme (collapsed sidebar); also the
  source of `frontend/public/favicon-light.png` (64 × 64, light browser chrome)

## viper-lockup-black.png
- Original: `visuals/viper-lockup-black.png` · App copy: `frontend/src/assets/brand/viper-lockup-black.png`
- Scope: global brand asset
- Status: selected/final-family
- Use: mark + VIPER wordmark on light backgrounds — `BrandLogo variant="lockup"` in the light theme (expanded
  sidebar; login/about later)

## viper-mark-white.png
- Original: `visuals/viper-mark-white.png` · App copy: `frontend/src/assets/brand/viper-mark-white.png`
- Scope: global brand asset
- Status: selected/final-family
- Use: mark-only on dark backgrounds — `BrandLogo variant="mark"` in the dark theme (collapsed sidebar); also the
  source of `frontend/public/favicon-dark.png` (64 × 64, dark browser chrome)

## viper-lockup-white.png
- Original: `visuals/viper-lockup-white.png` · App copy: `frontend/src/assets/brand/viper-lockup-white.png`
- Scope: global brand asset
- Status: selected/final-family
- Use: mark + VIPER wordmark on dark backgrounds — `BrandLogo variant="lockup"` in the dark theme (expanded
  sidebar, the default view)

## viper-mark-black-neon-green.png
- Original: `visuals/viper-mark-black-neon-green.png` · App copy:
  `frontend/src/assets/brand/viper-mark-black-neon-green.png`
- Scope: global brand asset
- Status: selected/final-family
- Use: dark/black primary with neon-green detail accents — `BrandLogo variant="accent"` in the **light** theme (the
  black body keeps the silhouette legible on light canvases)

## viper-mark-neon-green-black.png
- Original: `visuals/viper-mark-neon-green-black.png` · App copy:
  `frontend/src/assets/brand/viper-mark-neon-green-black.png`
- Scope: global brand asset
- Status: selected/final-family
- Use: neon-green primary with black details — `BrandLogo variant="accent"` in the **dark** theme (hero/premium
  moments; lime on light backgrounds would be ≈ 1.3:1)

All six logo variants were explicitly retained by the user for contrast/theme contexts. Do not substitute the literal
snake illustration from the moodboard for the selected geometric mark. Note: the logos' neon is a yellow-green lime,
while the UI accent token is Viper Green `#00E676` from the board; both are kept as delivered (see decision I-21).
